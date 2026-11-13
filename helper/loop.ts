// The helper's frame loop: the scene of the latest board and setup, painted at the rate the motion query asks for
// (20, 15, 1 or 0 fps), each frame written to a shared-memory name and announced on stdout as an F line.
// Time, painting, writing and timers come in as deps, so the specs drive it with a fake clock.
import { setupFrom } from '../hooks/map'
import type { Setup } from '../hooks/map'
import { motionAt } from '../hooks/paint/motion'
import type { Rate } from '../hooks/paint/motion'
import { pictureFor } from '../hooks/paint/scene-paint'
import type { PaintOptions, Picture } from '../hooks/paint/scene-paint'
import { sceneOf } from '../hooks/scene'
import type { Scene } from '../hooks/scene'
import type { Board } from '../types'

/** The body of POST /setup: the person's options, whether to paint in the light palette, and the ring box's rows. */
export type HelperSetup = { options: Record<string, unknown>; light: boolean; rows: number }

/** The body of POST /stats' answer. Counts are totals since start; `paintMs` and `shmMs` are averages per frame. */
export type HelperStats = { state: 'running' | 'still' | 'paused'; frames: number; skips: number; expired: number; paintMs: number; shmMs: number }

export type LoopDeps = {
  /** The helper's wall clock, in the plugin's `$.clock.now()` terms. */
  now: () => number
  /** The frame at moment t, as straight RGBA. The bytes may be reused by the next paint. */
  paint: (scene: Scene, t: number, picture: Picture, options: PaintOptions) => Uint8Array
  /** Writes a frame to a free name; undefined when every name is unread (the frame is skipped). */
  write: (bytes: Uint8Array, now: number) => { name: string; generation: number } | undefined
  /** Unlinks frames unread for over a second; how many. */
  expire: (now: number) => number
  /** One stdout line, without its newline. */
  emit: (line: string) => void
  /** Runs fn after ms; the result cancels it. */
  schedule: (ms: number, fn: () => void) => () => void
  /** How many written frames are unread, for the S line; 0 when not given. */
  unread?: () => number
}

/** Frames are never closer together than the fastest rate, however fast boards arrive. */
const MIN_GAP_MS = 50
/**
 * The longest single sleep. A later wake (a board dated ahead, a clock set back) is reached by several sleeps, each
 * re-checking the motion; timers never see a delay past what setTimeout can hold.
 */
const MAX_SLEEP_MS = 60_000
/** When a board's `now` and the helper's clock differ by more than this, the loop samples at its clock plus the offset fixed at that post. */
const SKEW_MS = 1000
/** Once still or paused, one expire this long after the last frame unlinks what the terminal never read. */
const EXPIRE_AFTER_MS = 1100
/** A frame owed while still, skipped because every name was unread, is tried again this soon. */
const RETRY_MS = 250
const S_EVERY_MS = 1000

type Posted = { board: Board; now: number; changedAt: number; offset: number }
type Prepared = { setup: Setup; picture: Picture; options: PaintOptions }
type Tally = { paints: number; frames: number; paintMs: number; shmMs: number }

const prepare = (h: HelperSetup): Prepared => {
  const setup = setupFrom(h.options)
  return { setup, picture: pictureFor(h.rows), options: { light: h.light, colors: setup.colors } }
}

const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
const average = (sum: number, n: number): number => (n === 0 ? 0 : sum / n)

export class FrameLoop {
  private posted: Posted | undefined
  private setup: HelperSetup | undefined
  private prepared: Prepared | undefined
  private scene: Scene | undefined
  private paused = false
  /** The last tick ran at a rate above 0, so the first still tick paints the last frame. */
  private moving = false
  /** A frame is owed even if the map is still: after a board, a setup or a resume, or a skipped last frame. */
  private owed = false
  private rate: Rate = 0
  /** When the pending tick is due. */
  private due = 0
  private cancelTick: (() => void) | undefined
  private cancelExpire: (() => void) | undefined
  private lastPaintAt: number | undefined
  private lastFrameAt: number | undefined
  private skips = 0
  private expired = 0
  private readonly total: Tally = { paints: 0, frames: 0, paintMs: 0, shmMs: 0 }
  /** The S line's second: from the first paint after a rest. */
  private second: (Tally & { from: number }) | undefined

  constructor(private readonly deps: LoopDeps) {}

  /** A new board, with the plugin's clock when it posted and the board's change time. Replans at once. */
  setBoard(board: Board, now: number, changedAt: number): void {
    const own = this.deps.now()
    this.posted = { board, now, changedAt, offset: Math.abs(now - own) > SKEW_MS ? now - own : 0 }
    this.scene = undefined
    this.owed = true
    this.replan()
  }

  /** Options, palette and size. Paints a frame even when still. */
  setSetup(setup: HelperSetup): void {
    this.setup = setup
    this.prepared = undefined
    this.scene = undefined
    this.owed = true
    this.replan()
  }

  /** The pane is hidden: no frames until `resume`. Boards and setups are kept. */
  pause(): void {
    this.paused = true
    this.stopTicking()
    this.second = undefined
    this.armExpire()
  }

  /** The pane is shown again: paints a frame even when still, then runs at the map's rate. */
  resume(): void {
    this.paused = false
    this.owed = true
    this.replan()
  }

  /**
   * One fresh frame now, even when still: a remounted Image needs a name it has not consumed yet. Nothing while
   * paused. A moving map just paints its next frame now.
   */
  frame(): void {
    if (this.paused) return
    this.owed = true
    this.replan()
  }

  stats(): HelperStats {
    const t = this.total
    return {
      state: this.paused ? 'paused' : this.moving && this.cancelTick !== undefined ? 'running' : 'still',
      frames: t.frames,
      skips: this.skips,
      expired: this.expired,
      paintMs: average(t.paintMs, t.paints),
      shmMs: average(t.shmMs, t.paints),
    }
  }

  private stopTicking(): void {
    this.cancelTick?.()
    this.cancelTick = undefined
  }

  /** Cancels the pending tick and plans one now, or once the last paint is MIN_GAP_MS old (never later, if the clock went back). */
  private replan(): void {
    this.stopTicking()
    if (this.paused || this.posted === undefined || this.setup === undefined) return
    const now = this.deps.now()
    const gap = this.lastPaintAt === undefined ? 0 : Math.min(MIN_GAP_MS, Math.max(0, this.lastPaintAt + MIN_GAP_MS - now))
    this.plan(now + gap, now)
  }

  /** The next tick at `at`, or after MAX_SLEEP_MS if that is sooner; the tick re-checks the motion either way. */
  private plan(at: number, now: number): void {
    this.due = at
    this.cancelTick = this.deps.schedule(Math.min(MAX_SLEEP_MS, Math.max(0, at - now)), () => this.tick())
  }

  private tick(): void {
    this.cancelTick = undefined
    const posted = this.posted
    if (this.paused || posted === undefined || this.setup === undefined) return
    const now = this.deps.now()
    const t = now + posted.offset
    let stage = 'scene'
    try {
      const prepared = (this.prepared ??= prepare(this.setup))
      const scene = (this.scene ??= sceneOf(posted.board, posted.now, prepared.setup))
      stage = 'motion'
      const { fps, wakeAt } = motionAt(scene, t, posted.changedAt)
      let skipped = false
      const paints = fps > 0 || this.moving || this.owed
      if (paints) {
        this.reportSecond(now)
        stage = 'paint'
        const a = performance.now()
        const bytes = this.deps.paint(scene, t, prepared.picture, prepared.options)
        const b = performance.now()
        stage = 'shm'
        this.expired += this.deps.expire(now)
        const put = this.deps.write(bytes, now)
        this.tally(now, b - a, performance.now() - b, put !== undefined)
        this.lastPaintAt = now
        if (put === undefined) {
          skipped = true
          this.skips++
        } else {
          this.lastFrameAt = now
          stage = 'emit'
          this.deps.emit(`F ${put.name} ${prepared.picture.width} ${prepared.picture.height} ${put.generation}`)
        }
      }
      this.owed = skipped && fps === 0
      if (fps > 0) {
        const period = 1000 / fps
        if (!this.moving || fps !== this.rate) this.due = now
        let due = this.due + period
        if (due < now) due += Math.ceil((now - due) / period) * period
        else if (due > now + period) due = now + period // the clock went back
        this.moving = true
        this.rate = fps
        this.plan(due, now)
        return
      }
      this.moving = false
      this.rate = 0
      this.second = undefined
      let next = skipped ? now + RETRY_MS : undefined
      if (wakeAt !== undefined) next = Math.min(next ?? Infinity, now + Math.ceil(wakeAt - t))
      if (next !== undefined) this.plan(next, now)
      // Only after a tick that painted: a wake that paints nothing leaves the planned expire alone.
      if (paints) this.armExpire()
    } catch (e) {
      this.deps.emit(`E ${stage}: ${oneLine(e)}`)
      this.owed = false
      this.moving = false
      this.rate = 0
      this.second = undefined
      this.armExpire()
    }
  }

  private tally(now: number, paintMs: number, shmMs: number, written: boolean): void {
    this.second ??= { from: now, paints: 0, frames: 0, paintMs: 0, shmMs: 0 }
    for (const t of [this.total, this.second]) {
      t.paints++
      t.paintMs += paintMs
      t.shmMs += shmMs
      if (written) t.frames++
    }
  }

  /** `S <frames> <avg paint ms> <avg shm ms> <unread> skips=<n> expired=<n>` once the current second is over. */
  private reportSecond(now: number): void {
    const s = this.second
    if (s === undefined || now - s.from < S_EVERY_MS) return
    this.second = undefined
    const ms = (sum: number) => average(sum, s.paints).toFixed(2)
    this.deps.emit(`S ${s.frames} ${ms(s.paintMs)} ${ms(s.shmMs)} ${this.deps.unread?.() ?? 0} skips=${this.skips} expired=${this.expired}`)
  }

  /** One expire, EXPIRE_AFTER_MS after the last frame, replacing any planned before. */
  private armExpire(): void {
    this.cancelExpire?.()
    this.cancelExpire = undefined
    if (this.lastFrameAt === undefined) return
    const now = this.deps.now()
    const wait = Math.min(EXPIRE_AFTER_MS, Math.max(0, this.lastFrameAt + EXPIRE_AFTER_MS - now))
    this.cancelExpire = this.deps.schedule(wait, () => {
      this.cancelExpire = undefined
      try {
        this.expired += this.deps.expire(this.deps.now())
      } catch (e) {
        this.deps.emit(`E expire: ${oneLine(e)}`)
      }
    })
  }
}

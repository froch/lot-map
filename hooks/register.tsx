import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, Register, UiBlitResult } from 'claude-code'

import type { Board, Entry, StationId, Status } from '../types'
import { STATIONS, classify, clean, describeNow, firstLine, foldRows, formatMs, memoryIds, setupFrom, shortModel } from './map'
import type { Setup } from './map'
import { changedAt } from './paint/motion'
import { DARK, LIGHT, lightPairs } from './palette'
import { drawMap } from './svg'
import { Coalescer, HelperPolicy, LineReader, PictureGate, newTag, ringBox, socketPath, terminalAllows } from './terminal'
import type { Env } from './terminal'
import type { HelperState, PictureStats, TextReason } from './text'

const PANE = 'lot-map'
const KEEP = 80
const CREW = 12

// Change the tag when a field of Entry or Board changes: it declines what an earlier version stored.
const board = atom({ plugin: 'lot-map', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'board-2' })

const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

// ---- the terminal picture ----------------------------------------------------------------------
// The helper (helper/painter.ts under bun) paints the map into shared memory and prints a line per frame; the pane's
// render hook starts it, feeds it over its socket and relays each frame to the Image. Everything here is plain data.

/** The tag naming the helper's socket and its shared-memory frames: kept for the session, so a reload finds it. */
const tagRef = atom({ plugin: 'lot-map', key: 'tag' } as const, '')

const HELPER = 'http://helper'
/** A render that finds no frame in this long asks for one: a remounted Image draws nothing until a fresh name comes. */
const STALE_MS = 250
/** Blits not yet answered past this many, a frame is let go: the helper unlinks what nobody read. */
const IN_FLIGHT_MAX = 8
const BLIT_SAMPLES = 600
const REFUSAL_KINDS = 8

type Shown = { reason: TextReason; cause?: string }
type Facts = { env: Env; bun?: string }
type ShmSource = { shm: string; format: 'rgba'; width: number; height: number; generation: number }
type PixelSource = { rgba: string; width: number; height: number }

/** The helper and what the terminal pane last drew, for this load of the module. Never `$`. */
type Picture = {
  tag?: string
  /** The environment and where bun is, read once. */
  facts?: Promise<Facts>
  /** Why the terminal pane last drew text; undefined while it draws the picture. */
  shown?: Shown
  /** Text for the rest of the module's life: the socket failed, or the helper exited three times in a minute. */
  blocked?: Shown
  gate: PictureGate
  policy: HelperPolicy
  coalescer: Coalescer<Board>
  /** Which helper run is current: a loop, a blit or a timer of an older run does nothing. */
  run: number
  helper: HelperState
  /** The current run printed R and has its setup and board. */
  ready: boolean
  paused: boolean
  /** Ends the current run's stdout loop, which kills the helper. */
  end?: () => void
  socket: string
  /** The newest frame the Image took: what a redraw draws, the engine never sending it again. */
  lastFrame?: ShmSource
  lastFrameSeq: number
  sentSeq: number
  inFlight: number
  /** When the last F line came, and when a frame was last asked for (R, /frame), by the engine's clock. */
  lastFAt: number
  askedAt: number
  /** Claude Code's `theme` row, read on the first render and on each change. */
  themeRow?: string
  /** The ring box's rows and the board the pane last drew. */
  rows: number
  board: Board
  /** The last board offered and the last setup posted, as JSON. */
  offered: string
  setupSent: string
  /** The coalescer a flush timer is armed for. */
  armed?: Coalescer<Board>
  taken: number
  refused: number
  refusals: Map<string, number>
  blitMs: number[]
  lastS?: string
  lastE?: string
  restarts: number
  sent: number
  coalesced: number
}

const freshPicture = (): Picture => ({
  shown: { reason: 'undrawn' },
  gate: new PictureGate(),
  policy: new HelperPolicy(),
  coalescer: new Coalescer<Board>(),
  run: 0,
  helper: 'idle',
  ready: false,
  paused: false,
  socket: '',
  lastFrameSeq: 0,
  sentSeq: 0,
  inFlight: 0,
  lastFAt: -Infinity,
  askedAt: -Infinity,
  rows: 0,
  board: { entries: [], counts: {} },
  offered: '',
  setupSent: '',
  taken: 0,
  refused: 0,
  refusals: new Map(),
  blitMs: [],
  restarts: 0,
  sent: 0,
  coalesced: 0,
})

/** Ends the current run, if any: its loop and timers stop at their next step, and the helper is killed. */
function stopHelper(pic: Picture, state: HelperState): void {
  pic.run++
  pic.ready = false
  pic.paused = false
  pic.helper = state
  const end = pic.end
  pic.end = undefined
  end?.()
}

/**
 * A request to the helper refused or failed: the pane shows text from now on and the helper is stopped. True the
 * first time, when the caller tells the person once.
 */
function socketFailed(pic: Picture, run: number, cause: string): boolean {
  if (run !== pic.run || pic.blocked !== undefined) return false
  pic.blocked = { reason: 'socket', cause }
  stopHelper(pic, 'stopped')
  return true
}

const oneLine = (failure: unknown): string => firstLine(failure instanceof Error ? failure.message : String(failure), 120)

/** Why a request to the helper came to nothing; undefined when it was answered ok. */
async function reached(path: string, request: () => Promise<HttpResponse>): Promise<string | undefined> {
  try {
    const answer = await request()
    return answer.ok ? undefined : `${path} ${answer.status}${answer.text.trim() === '' ? '' : `: ${firstLine(answer.text, 120)}`}`
  } catch (failure) {
    return `${path}: ${oneLine(failure)}`
  }
}

const keep = (list: number[], value: number): void => {
  list.push(value)
  if (list.length > BLIT_SAMPLES) list.shift()
}

function statsOf(pic: Picture): PictureStats {
  const ms = [...pic.blitMs].sort((a, b) => a - b)
  return {
    ...(pic.shown === undefined ? {} : { text: pic.shown }),
    taken: pic.taken,
    refused: pic.refused,
    refusals: [...pic.refusals],
    helper: pic.helper,
    restarts: pic.restarts,
    ...(ms.length === 0 ? {} : { blitMs: { average: ms.reduce((a, b) => a + b, 0) / ms.length, p95: ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]! } }),
    ...(pic.lastS === undefined ? {} : { lastS: pic.lastS }),
    ...(pic.lastE === undefined ? {} : { lastE: pic.lastE }),
    posts: { sent: pic.sent, coalesced: pic.coalesced },
  }
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** One opaque pixel of `#rrggbb` as an Image's rgba bytes. */
function pixel(hex: string): PixelSource {
  const n = parseInt(hex.slice(1, 7), 16)
  const at = (shift: number): string => BASE64[(n >> shift) & 63]!
  return { rgba: `${at(18)}${at(12)}${at(6)}${at(0)}/w==`, width: 1, height: 1 }
}

/** What the Image shows before its first frame: one pixel of the map's ground, or a clear one without a ground. */
function placeholder(setup: Setup, light: boolean): PixelSource {
  if (setup.background === 'transparent') return { rgba: 'AAAAAA==', width: 1, height: 1 }
  const ground = setup.colors.ground ?? (setup.theme === 'light' ? LIGHT.ground : DARK.ground)
  return pixel(light ? (lightPairs(setup.colors).get(ground) ?? ground) : ground)
}

type Start = {
  station: StationId
  label: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  /** Adds nothing to the station's count: a second view of something already counted. */
  uncounted?: boolean
  startedAt?: number
  endedAt?: number
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

async function begin($: EngineInterface, start: Start): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const entry: Entry = {
      id: newId(now),
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: start.startedAt ?? now,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: start.endedAt ?? now } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
    }
    await update($, board, b => ({
      ...b,
      ...start.patch,
      entries: [...b.entries, entry].slice(-KEEP),
      counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      // What a hook brought to memory unasked is counted apart from what was asked for.
      ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
      // An interrupted turn lands on the person's own station and is no fault of anything.
      ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
      ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId)
        ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) }
        : {}),
    }))
    return entry.id
  })
}

async function finish($: EngineInterface, id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => {
      const open = b.entries.find(e => e.id === id && e.status === 'run')
      return {
        ...b,
        ...patch,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(open !== undefined && isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** How full the context window is, as the status line has it; costs nothing. */
async function contextOf($: EngineInterface): Promise<Pick<Board, 'context'>> {
  const percent = await quietly(async () => (await $.session.usage()).context.percent)
  return typeof percent === 'number' ? { context: percent } : {}
}

/** What a settings hook added to the context: shown as the hook acting and, when it brought records, as memory. */
async function noteContext($: EngineInterface, context: readonly string[] | undefined, when: string, setup: Setup): Promise<void> {
  const { t } = setup
  const text = (context ?? []).join('\n')
  if (text.trim() === '') return
  const ids = setup.hookRecords ? memoryIds(text) : []
  if (ids.length === 0) {
    await begin($, { station: 'hooks', label: t.addedContext(when), status: 'ok' })
    return
  }
  await begin($, { station: 'hooks', label: t.addedMemory(when), status: 'ok' })
  const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
  await begin($, {
    station: 'memory',
    label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`),
    from: 'inbound',
    status: 'ok',
  })
}

export const register: Register = (on, options) => {
  const setup = setupFrom(options)
  const { t } = setup
  // The feed's second column fits the longest station name of the language.
  const column = Math.max(8, ...Object.values(t.stations).map(name => name.length))

  const pic = freshPicture()
  /** In auto, the map follows Claude Code's theme row; a dark or light setting is already in its palette. */
  const isLight = (): boolean => setup.theme === 'auto' && (pic.themeRow ?? '').startsWith('light')
  const setupBody = (): string => JSON.stringify({ options, light: isLight(), rows: pic.rows })

  // Calls a settings hook refused, so that the tool's own row reads as blocked and not as an error.
  // Loses nothing across a reload that matters: a reload never lands in the middle of a call.
  const refused = new Set<string>()

  // The model the main loop last ran on: in this session, or else in the last session in this folder.
  // The one thing the map keeps between sessions, and only its name.
  let lastModel: string | undefined
  let modelKey = 'model'

  on('session.start', async ($, e, next) => {
    await quietly(async () => {
      // Made once a session and kept, so a reloaded module's helper takes the same names and cleans what was left.
      const stored = await read($, tagRef)
      const tag = (pic.tag ??= stored || newTag(Math.random))
      if (stored !== tag) await update($, tagRef, () => tag)
    })
    await quietly(() => $.command.register({ name: 'lot-map', description: t.command }))
    void quietly(() => $.ui.open({ id: PANE, title: t.title }))
    await quietly(async () => {
      modelKey = `model:${e.cwd}`
      const kept = await $.store.get(modelKey)
      if (lastModel === undefined && typeof kept === 'string') lastModel = kept
    })
    return next(e)
  })

  on('command.run', { command: 'lot-map' }, async ($, e) => {
    if (e.args.trim() === 'stats') return { text: t.stats(statsOf(pic)) }
    const opened = await $.ui.open({ id: PANE, title: t.title })
    return { text: opened.isPlaced ? t.opened : t.cannotOpen(String(opened.reason)) }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && e.text !== '') {
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => update($, board, b => (b.faults === undefined ? b : { ...b, faults: {} })))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain && lastModel !== e.model) {
      const before = lastModel
      lastModel = e.model
      void quietly(() => $.store.set(modelKey, e.model))
      if (before !== undefined) {
        const now = await quietly(() => $.clock.now())
        await begin($, {
          station: 'model',
          label: `${shortModel(before)} → ${shortModel(e.model)}`,
          status: 'ok',
          mark: 'switch',
          uncounted: true,
          ...(now !== undefined ? { patch: { switchedAt: now } } : {}),
        })
      }
    }
    const id = await begin($, {
      station: 'model',
      label: `${shortModel(e.model)} · ${t.step(e.index + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    try {
      return yield* next(e)
    } finally {
      await finish($, id, 'ok', isMain ? await contextOf($) : undefined)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's loop is over: it leaves the agents station, and a call of its that never reported back is settled.
      const agentId = e.agentId
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          agents: (b.agents ?? []).filter(id => id !== agentId),
          entries: b.entries.map(x => (x.status === 'run' && x.agentId === agentId ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    } else {
      await begin($, {
        station: 'you',
        label: e.isAborted ? t.turnAborted : t.answerReady,
        status: e.isAborted ? 'err' : 'ok',
        ...(e.isAborted ? {} : { mark: 'done' as const }),
      })
      // An interrupted call never reports back; left alone its row would pulse for the rest of the session.
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          entries: b.entries.map(x => (x.status === 'run' && x.from === 'core' ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = await quietly(async () => {
      const seen = classify(e.tool, e as unknown as Record<string, unknown>, setup)
      return begin($, { ...seen, ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
    })
    try {
      const ran = await next(e)
      const wasRefused = ran.deny !== undefined || (e.tool_use_id !== undefined && refused.delete(e.tool_use_id))
      await finish($, id, wasRefused ? 'block' : ran.isError === true ? 'err' : 'ok')
      return ran
    } catch (failure) {
      await finish($, id, 'err')
      throw failure
    }
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const startedAt = (await quietly(() => $.clock.now())) ?? 0
    const decided = await next(e)
    const endedAt = (await quietly(() => $.clock.now())) ?? startedAt
    if (decided.deny !== undefined) {
      if (e.tool_use_id !== undefined) refused.add(e.tool_use_id)
      await begin($, { station: 'hooks', label: (setup.hookReasons ? firstLine(decided.deny) : '') || t.stopped(e.tool), status: 'block', startedAt })
    } else if (decided.ask !== undefined) {
      await begin($, { station: 'hooks', label: t.askedPermission(e.tool), status: 'ok', startedAt, endedAt })
    } else if (endedAt - startedAt >= 400) {
      // A check that took a moment is worth seeing; the instant ones are not.
      await begin($, { station: 'hooks', label: t.checkBefore(e.tool), status: 'ok', startedAt, endedAt })
    }
    return decided
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.toMessage, setup)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.atStart, setup)
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    // A skill the model called is already on the map as its tool call; this one catches a typed slash command.
    await quietly(async () => {
      const now = await $.clock.now()
      await update($, board, b => {
        if (b.entries.some(x => x.station === 'skills' && x.status === 'run' && x.label === e.skill)) return b
        const entry: Entry = { id: newId(now), station: 'skills', label: e.skill, from: 'core', startedAt: now, endedAt: now, status: 'ok' }
        return { ...b, entries: [...b.entries, entry].slice(-KEEP), counts: { ...b.counts, skills: (b.counts.skills ?? 0) + 1 } }
      })
    })
    return result
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      await quietly(async () => {
        pic.themeRow = String(result.value)
        const run = pic.run
        const body = setupBody()
        if (pic.ready && body !== pic.setupSent) {
          pic.setupSent = body
          const cause = await reached('/setup', () => $.http.fetch(`${HELPER}/setup`, { method: 'POST', body, socketPath: pic.socket }))
          if (cause !== undefined && socketFailed(pic, run, cause)) $.ui.toast(t.socketRefused(cause))
        }
        $.ui.invalidate('ui.render')
      })
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    const id = await begin($, { station: 'model', label: t.compacting })
    try {
      return await next(e)
    } finally {
      await finish($, id, 'ok', await contextOf($))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)

    const lines = foldRows(state.entries).map(({ entry, times, tookMs }) => {
      const isSwitch = entry.mark === 'switch'
      const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
      const took = entry.endedAt === undefined ? t.running : tookMs > 0 ? formatMs(tookMs, t) : ''
      // Theme keys, so the rows read on a light theme as well as on a dark one.
      const color = isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error'
      const line = `${mark} ${t.stations[entry.station].padEnd(column)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}${took === '' ? '' : `  ${took}`}`
      return { line, color, isDim: entry.status === 'ok' && !isSwitch }
    })
    const rows = lines.map(({ line, color, isDim }) => (
      <Text mono size="footnote" color={color} dimColor={isDim}>
        {line}
      </Text>
    ))
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    const current = <Text mono size="footnote">{describeNow(state, t)}</Text>

    if (e.surface === 'terminal') {
      const box = e.props.placement === 'dock' ? ringBox(e.props.scroll.bodyRows, e.props.bodyColumns) : undefined
      let why: Shown | undefined =
        setup.terminal === 'text'
          ? { reason: 'option' }
          : e.props.placement !== 'dock'
            ? { reason: 'inline' }
            : box === undefined
              ? { reason: 'small' }
              : pic.blocked
      let facts: Facts | undefined
      if (why === undefined) {
        // The environment and bun are read once; a variable the engine will not give counts as unset.
        pic.facts ??= (async (): Promise<Facts> => {
          const env: Record<string, string | undefined> = {}
          let isWhole = true
          const take = async (name: string, value: Promise<string | undefined>): Promise<void> => {
            try {
              env[name] = await value
            } catch {
              isWhole = false
            }
          }
          try {
            await Promise.all([
              take('TERM_PROGRAM', $.env.get('TERM_PROGRAM')),
              take('TERM', $.env.get('TERM')),
              take('KITTY_WINDOW_ID', $.env.get('KITTY_WINDOW_ID')),
              take('TMUX', $.env.get('TMUX')),
              take('ZELLIJ', $.env.get('ZELLIJ')),
              take('STY', $.env.get('STY')),
              take('SSH_CONNECTION', $.env.get('SSH_CONNECTION')),
              take('SSH_TTY', $.env.get('SSH_TTY')),
              take('TMPDIR', $.env.get('TMPDIR')),
              take('HOME', $.env.get('HOME')),
            ])
          } catch {
            isWhole = false
          }
          // What could not be read is read again at the next render, rather than kept as unset for the session.
          if (!isWhole) {
            pic.facts = undefined
            return { env: {} }
          }
          if (!terminalAllows(env)) return { env }
          // bun on PATH, else where its installer puts it; nothing is run for a terminal that gets text anyway.
          const onPath = await quietly(() => $.process.run(['bun', '--version'], { timeoutMs: 10_000 }))
          if (onPath?.exitCode === 0) return { env, bun: 'bun' }
          const own = env.HOME ? `${env.HOME.replace(/\/+$/, '')}/.bun/bin/bun` : undefined
          if (own !== undefined && (await quietly(() => $.fs.exists(own))) === true) return { env, bun: own }
          return { env }
        })()
        facts = await pic.facts
        if (!terminalAllows(facts.env)) why = { reason: 'terminal' }
        else if (facts.bun === undefined) why = { reason: 'bun' }
        else {
          // A minute after the terminal drew no images, the gate reopens and a fresh helper is tried.
          pic.gate.rendered(now)
          if (!pic.gate.showsPicture()) why = { reason: 'images' }
        }
      }

      let source: ShmSource | PixelSource | undefined
      if (why === undefined && box !== undefined && facts?.bun !== undefined) {
        const bun = facts.bun
        const env = facts.env
        const rowsAvailable = box.rows

        /** POSTs to the helper; a refusal or a failure gives the text view, the helper stopped and the person told once. */
        const post = (run: number, path: string, body = '{}'): Promise<unknown> =>
          quietly(async () => {
            const cause = await reached(path, () => $.http.fetch(`${HELPER}${path}`, { method: 'POST', body, socketPath: pic.socket }))
            if (cause !== undefined && socketFailed(pic, run, cause)) {
              $.ui.invalidate('ui.render')
              $.ui.toast(t.socketRefused(cause))
            }
          })
        const postBoard = async (run: number, b: Board, at: number): Promise<void> => {
          pic.sent++
          await post(run, '/board', JSON.stringify({ board: b, now: at, changedAt: changedAt(b) }))
        }
        /** One timer per pending board: when it fires, the newest board offered goes. */
        const arm = (run: number, coalescer: Coalescer<Board>, at: number): void => {
          const wait = coalescer.waitMs(at)
          if (pic.armed === coalescer || wait === undefined) return
          pic.armed = coalescer
          $.clock.after(wait, () => {
            void quietly(async () => {
              if (pic.armed === coalescer) pic.armed = undefined
              if (run !== pic.run || coalescer !== pic.coalescer) return
              const due = await $.clock.now()
              const next = coalescer.due(due)
              if (next !== undefined) await postBoard(run, next, due)
              else arm(run, coalescer, due)
            })
          })
        }
        /** Each frame to the Image, by its name and generation; what the terminal answers goes to the gate. */
        const relay = (run: number, f: { name: string; width: number; height: number; generation: number }): void => {
          void quietly(async () => {
            pic.lastFAt = Math.max(pic.lastFAt, await $.clock.now())
          })
          if (pic.inFlight >= IN_FLIGHT_MAX) return
          const frame: ShmSource = { shm: f.name, format: 'rgba', width: f.width, height: f.height, generation: f.generation }
          const seq = ++pic.sentSeq
          pic.inFlight++
          const sentAt = performance.now()
          void quietly(async () => {
            let answer: UiBlitResult
            try {
              answer = await $.ui.blit({ requestId: PANE, key: 'map', source: frame })
            } catch (failure) {
              answer = { deny: `the blit failed: ${oneLine(failure)}` }
            } finally {
              pic.inFlight--
            }
            if (run !== pic.run) return
            keep(pic.blitMs, performance.now() - sentAt)
            if (answer.deny === undefined) {
              pic.taken++
              pic.gate.accepted(now) // the gate keeps no time for a taken frame
              if (seq > pic.lastFrameSeq) {
                pic.lastFrameSeq = seq
                pic.lastFrame = frame
              }
              return
            }
            pic.refused++
            const words = firstLine(answer.deny, 160)
            if (pic.refusals.has(words) || pic.refusals.size < REFUSAL_KINDS) pic.refusals.set(words, (pic.refusals.get(words) ?? 0) + 1)
            const at = await $.clock.now()
            if (run !== pic.run) return
            const next = pic.gate.refused(answer.deny, at)
            if (next.next === 'text') {
              stopHelper(pic, 'stopped')
              $.ui.invalidate('ui.render')
            } else if (next.next === 'pause' && pic.ready && !pic.paused) {
              pic.paused = true
              pic.helper = 'paused'
              await post(run, '/pause')
            }
          })
        }
        /**
         * Once the helper listens: its setup, then the board as it stands. Renders feed it only after that, so the
         * first board is this one; a setup that changed meanwhile goes after it.
         */
        const ready = async (run: number): Promise<void> => {
          pic.helper = 'running'
          pic.setupSent = setupBody()
          await post(run, '/setup', pic.setupSent)
          const at = await $.clock.now()
          if (run !== pic.run) return
          pic.askedAt = at // the setup and the board paint a frame of their own
          const first = pic.board
          pic.offered = JSON.stringify(first)
          pic.coalescer.offer(first, at) // a fresh coalescer: the first offer always goes
          pic.ready = true
          await postBoard(run, first, at)
          const body = setupBody()
          if (run === pic.run && body !== pic.setupSent) {
            pic.setupSent = body
            await post(run, '/setup', body)
          }
        }
        /** Starts a helper and reads it for the session's life; one that ends on its own goes to the policy. */
        const start = (tag: string): void => {
          const run = ++pic.run
          pic.helper = 'starting'
          pic.ready = false
          pic.paused = false
          pic.lastFrame = undefined
          pic.socket = socketPath(env, tag)
          pic.coalescer = new Coalescer<Board>()
          pic.offered = ''
          pic.setupSent = ''
          void quietly(async () => {
            try {
              const child = $.process.spawn({ argv: [bun, `${$.plugin.root}/helper/painter.ts`, pic.socket, tag] })
              pic.end = () => {
                void child.return({ code: null, signal: null }).catch(() => undefined)
              }
              const reader = new LineReader()
              reading: for await (const piece of child) {
                if (run !== pic.run) break
                if (piece.stream !== 'stdout') continue
                for (const line of reader.push(piece.text)) {
                  if (run !== pic.run) break reading
                  if (line.kind === 'R') await ready(run)
                  else if (line.kind === 'F') relay(run, line)
                  else if (line.kind === 'S') pic.lastS = line.text
                  else {
                    pic.lastE = line.message
                    break reading
                  }
                }
              }
            } catch {
              // The stream failed or the helper would not start: an exit like any other.
            }
            if (run !== pic.run) return // ended by the plugin
            pic.end = undefined
            pic.ready = false
            pic.paused = false
            const next = pic.policy.exited(await $.clock.now())
            if ('giveUp' in next) {
              pic.blocked = { reason: 'helper' }
              stopHelper(pic, 'given-up')
              $.ui.invalidate('ui.render')
              return
            }
            pic.helper = 'restarting'
            pic.restarts++
            $.clock.after(next.restartIn, () => {
              if (run === pic.run && pic.helper === 'restarting' && pic.blocked === undefined && pic.gate.showsPicture()) start(tag)
            })
          })
        }
        /** What changed since the helper last heard: its setup, the board, a pause to lift, or no recent frame. */
        const feedHelper = (): void => {
          const run = pic.run
          let isSending = false
          const body = setupBody()
          if (body !== pic.setupSent) {
            pic.setupSent = body
            isSending = true
            void post(run, '/setup', body)
          }
          const json = JSON.stringify(state)
          if (json !== pic.offered) {
            pic.offered = json
            const coalescer = pic.coalescer
            const wasPending = coalescer.waitMs(now) !== undefined
            const next = coalescer.offer(state, now)
            if (next !== undefined) {
              isSending = true
              void postBoard(run, next, now)
            } else {
              if (wasPending) pic.coalesced++
              arm(run, coalescer, now)
            }
          }
          if (pic.paused) {
            pic.paused = false
            pic.helper = 'running'
            void post(run, '/resume')
          } else if (!isSending && now - Math.max(pic.lastFAt, pic.askedAt) >= STALE_MS) {
            pic.askedAt = now
            void post(run, '/frame')
          }
        }

        source = await quietly(async () => {
          pic.board = state
          pic.rows = rowsAvailable
          if (pic.themeRow === undefined) {
            const config = await quietly(() => $.config.list())
            pic.themeRow = String(config?.find(row => row.key === 'theme')?.value ?? '')
          }
          const tag = (pic.tag ??= (await quietly(() => read($, tagRef))) || newTag(Math.random))
          if (pic.helper === 'idle' || pic.helper === 'stopped') start(tag)
          else if (pic.ready) feedHelper()
          return pic.lastFrame ?? placeholder(setup, isLight())
        })
        if (source === undefined) why = { reason: 'failed' }
      }
      pic.shown = why

      if (source !== undefined && box !== undefined) {
        // The picture, then the now line and the feed, each one row, as many as fit under it.
        const { Image } = $.ui.resolve(e)
        const below = [
          <Text mono size="footnote" wrap="truncate-end">
            {describeNow(state, t)}
          </Text>,
          ...(lines.length > 0
            ? lines.map(({ line, color, isDim }) => (
                <Text mono size="footnote" color={color} dimColor={isDim} wrap="truncate-end">
                  {line}
                </Text>
              ))
            : [
                <Text dimColor wrap="truncate-end">
                  {t.nothingYet}
                </Text>,
              ]),
        ].slice(0, Math.max(0, e.props.scroll.bodyRows - box.rows))
        return (
          <Box flexDirection="column">
            <Box justifyContent="center">
              <Image key="map" source={source} columns={box.columns} rows={box.rows} alt={`${t.title}. ${describeNow(state, t)}`} />
            </Box>
            {below}
          </Box>
        )
      }

      const tally = STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => `${t.stations[s.id]} ${state.counts[s.id]}`).join(' · ')
      return (
        <Box flexDirection="column">
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {feed}
        </Box>
      )
    }

    const { Svg } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Svg source={drawMap(state, now, setup)} alt={`${t.title}. ${describeNow(state, t)}`} />
        {current}
        {feed}
      </Box>
    )
  })
}

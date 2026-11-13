import { atom, read, update } from 'claude-code'
import type { EngineInterface, HttpResponse, Register, UiBlitResult } from 'claude-code'

import type { Board, Entry, StationId, Status } from '../types'
import { STATIONS, classify, clean, describeNow, firstLine, foldRows, formatMs, memoryIds, setupFrom, shortModel } from './map'
import type { Setup } from './map'
import { boardBody, setupBody } from './helper-bodies'
import { DARK, LIGHT, lightPairs } from './palette'
import { drawMap } from './svg'
import { Coalescer, HelperPolicy, LineReader, PictureGate, isNotMounted, newTag, ringBox, socketPath, terminalAllows } from './terminal'
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
/** A helper that has not printed R this long after its spawn is taken for hung. */
const LISTEN_MS = 5000
/** A helper asked to quit whose loop has not ended this long after is killed. */
const QUIT_MS = 1000
/** Blits not yet answered past this many, a frame is let go: the helper unlinks what nobody read. */
const IN_FLIGHT_MAX = 8
/** A frame the Image did not take, still the newest this long after, is asked for again with /frame. */
const RETRY_MS = 150
/** At most this many times in a row: a taken frame starts the count again. */
const RETRIES_MAX = 5
/** A not-mounted refusal this soon after a render asked for a frame means the Image is not mounted yet. */
const MOUNT_MS = 500
const BLIT_SAMPLES = 600
const REFUSAL_KINDS = 8

type Shown = { reason: TextReason; cause?: string }
type Facts = { env: Env; bun?: string }
type ShmSource = { shm: string; format: 'rgba'; width: number; height: number; generation: number }
type PixelSource = { rgba: string; width: number; height: number }

/** One helper process, from its spawn to the end of its reading loop. A run no longer current does nothing. */
type Run = {
  tag: string
  socket: string
  /** It printed R. */
  isListening: boolean
  /** Its setup and first board are posted: renders feed it from now on. */
  isFed: boolean
  /** Its stdout loop has ended, and with it the child. */
  hasEnded: boolean
  /** It has counted against the policy, which it does once. */
  hasFailed: boolean
  /** The frame (by its seq) a pending timer will ask again for, if it is still the newest and not taken. */
  asking?: number
}

/** The helper and what the terminal pane last drew, for this load of the module. Never `$`. */
type Picture = {
  tag?: string
  /** The environment and where bun is, read once. */
  facts?: Promise<Facts>
  /** Why the terminal pane last drew text; undefined while it draws the picture. */
  shown?: Shown
  /** Text for the rest of the module's life: the helper failed three times in a minute. */
  blocked?: Shown
  gate: PictureGate
  policy: HelperPolicy
  coalescer: Coalescer<Board>
  /** The helper run in force: a loop, a blit, a post or a timer of any other run does nothing. */
  current?: Run
  helper: HelperState
  paused: boolean
  /** The newest frame the Image took: what a redraw draws, the engine never sending it again. */
  lastFrame?: ShmSource
  /** F lines are numbered as they come: the newest taken, the newest relayed, the newest known not taken. */
  lastFrameSeq: number
  sentSeq: number
  missedSeq: number
  /** /frame posts in a row asking again for a frame not taken. */
  retries: number
  inFlight: number
  /** When the last F line came, and when a frame was last asked for (R, /frame), by the engine's clock. */
  lastFAt: number
  askedAt: number
  /** When a render last posted the helper something that paints a frame. */
  renderAskedAt: number
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
  dropped: number
  retried: number
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
  helper: 'idle',
  paused: false,
  lastFrameSeq: 0,
  sentSeq: 0,
  missedSeq: 0,
  retries: 0,
  inFlight: 0,
  lastFAt: -Infinity,
  askedAt: -Infinity,
  renderAskedAt: -Infinity,
  rows: 0,
  board: { entries: [], counts: {} },
  offered: '',
  setupSent: '',
  taken: 0,
  refused: 0,
  dropped: 0,
  retried: 0,
  refusals: new Map(),
  blitMs: [],
  restarts: 0,
  sent: 0,
  coalesced: 0,
})

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
    dropped: pic.dropped,
    retries: pic.retried,
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
  const setupNow = (): string => setupBody(options, isLight(), pic.rows)

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
      // The redraw posts the helper its new setup, where a failed post is handled with every other.
      pic.themeRow = String(result.value)
      await quietly(async () => $.ui.invalidate('ui.render'))
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

        /** Ends a run: it is stale at once, then asked to quit, and killed if its loop has not ended a second later. */
        const stop = (run: Run, state: HelperState): void => {
          if (pic.current === run) {
            pic.current = undefined
            pic.helper = state
            pic.paused = false
          }
          if (run.hasEnded) return
          void quietly(() => $.http.fetch(`${HELPER}/quit`, { method: 'POST', body: '{}', socketPath: run.socket }))
          $.clock.after(QUIT_MS, () => {
            if (!run.hasEnded) void quietly(() => $.process.run(['pkill', '-TERM', '-f', run.socket], { timeoutMs: 5000 }))
          })
        }
        /**
         * A run that failed, counted once: it is stopped, then a fresh one starts after 1 s or 5 s; the third failure in
         * a minute gives the text view for the session, and the person is told once.
         */
        const fail = async (run: Run, cause: string): Promise<void> => {
          if (run.hasFailed || run !== pic.current) return
          run.hasFailed = true
          stop(run, 'restarting')
          const next = pic.policy.exited(await $.clock.now())
          if ('giveUp' in next) {
            pic.helper = 'given-up'
            pic.blocked = { reason: 'helper', cause }
            $.ui.invalidate('ui.render')
            $.ui.toast(t.helperGaveUp(cause))
            return
          }
          pic.restarts++
          $.clock.after(next.restartIn, () => {
            if (pic.current !== undefined || pic.helper !== 'restarting') return
            if (pic.blocked === undefined && pic.gate.showsPicture()) start(run.tag)
            else pic.helper = 'stopped'
          })
        }
        /** POSTs to the helper; a refusal or a failure is the run's failure. */
        const post = (run: Run, path: string, body = '{}'): Promise<unknown> =>
          quietly(async () => {
            const cause = await reached(path, () => $.http.fetch(`${HELPER}${path}`, { method: 'POST', body, socketPath: run.socket }))
            if (cause !== undefined) await fail(run, cause)
          })
        const postBoard = async (run: Run, b: Board, at: number): Promise<void> => {
          pic.sent++
          await post(run, '/board', boardBody(b, at))
        }
        /** One timer per pending board: when it fires, the newest board offered goes. */
        const arm = (run: Run, coalescer: Coalescer<Board>, at: number): void => {
          const wait = coalescer.waitMs(at)
          if (pic.armed === coalescer || wait === undefined) return
          pic.armed = coalescer
          $.clock.after(wait, () => {
            void quietly(async () => {
              if (pic.armed === coalescer) pic.armed = undefined
              if (run !== pic.current || coalescer !== pic.coalescer) return
              const due = await $.clock.now()
              const next = coalescer.due(due)
              if (next !== undefined) await postBoard(run, next, due)
              else arm(run, coalescer, due)
            })
          })
        }
        /**
         * While the newest frame is one the Image did not take, asks the helper for another RETRY_MS later if no newer
         * frame came meanwhile (a moving map sends its own), at most RETRIES_MAX times in a row: a lasting refusal
         * never keeps a still map painting. A still map paints one frame, so without this a lost one stays lost.
         */
        const askAgain = (run: Run): void => {
          const seq = pic.sentSeq
          if (run.asking === seq || pic.paused || pic.retries >= RETRIES_MAX || pic.missedSeq !== seq) return
          run.asking = seq
          try {
            $.clock.after(RETRY_MS, () => {
              if (run.asking === seq) run.asking = undefined
              if (run !== pic.current || pic.sentSeq !== seq || pic.missedSeq !== seq) return
              if (pic.paused || pic.retries >= RETRIES_MAX) return
              pic.retries++
              pic.retried++
              void post(run, '/frame')
            })
          } catch {
            run.asking = undefined // no timer: the next render asks for a frame if none came
          }
        }
        /** Frame `seq` was not taken: if it is the newest, the helper is asked for another. */
        const missed = (run: Run, seq: number): void => {
          pic.missedSeq = Math.max(pic.missedSeq, seq)
          askAgain(run)
        }
        /** Each frame to the Image, by its name and generation; what the terminal answers goes to the gate. */
        const relay = (run: Run, f: { name: string; width: number; height: number; generation: number }): void => {
          void quietly(async () => {
            pic.lastFAt = Math.max(pic.lastFAt, await $.clock.now())
          })
          const seq = ++pic.sentSeq
          if (pic.inFlight >= IN_FLIGHT_MAX) {
            pic.dropped++
            missed(run, seq)
            return
          }
          const frame: ShmSource = { shm: f.name, format: 'rgba', width: f.width, height: f.height, generation: f.generation }
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
            if (run !== pic.current) return
            keep(pic.blitMs, performance.now() - sentAt)
            if (answer.deny === undefined) {
              pic.taken++
              pic.retries = 0
              pic.gate.accepted(now) // the gate keeps no time for a taken frame
              if (seq > pic.lastFrameSeq) {
                pic.lastFrameSeq = seq
                pic.lastFrame = frame
              }
              askAgain(run) // an older frame taken while the newest was not: that one is still owed
              return
            }
            pic.refused++
            const words = firstLine(answer.deny, 160)
            if (pic.refusals.has(words) || pic.refusals.size < REFUSAL_KINDS) pic.refusals.set(words, (pic.refusals.get(words) ?? 0) + 1)
            const at = await $.clock.now()
            if (run !== pic.current) return
            const next = pic.gate.refused(answer.deny, at)
            // A render's ask can beat the Image's mount: not mounted that soon after is asked again, not paused.
            const isMounting = isNotMounted(answer.deny) && at - pic.renderAskedAt <= MOUNT_MS
            if (next.next === 'text') {
              stop(run, 'stopped')
              $.ui.invalidate('ui.render')
            } else if (next.next === 'pause' && !isMounting) {
              pic.missedSeq = Math.max(pic.missedSeq, seq)
              if (run.isFed && !pic.paused) {
                pic.paused = true
                pic.helper = 'paused'
                await post(run, '/pause')
              }
            } else {
              missed(run, seq)
            }
          })
        }
        /**
         * Once the helper listens: its setup, then the board as it stands. Renders feed it only after that, so the
         * first board is this one; a setup that changed meanwhile goes after it.
         */
        const ready = async (run: Run): Promise<void> => {
          run.isListening = true
          pic.helper = 'running'
          pic.setupSent = setupNow()
          await post(run, '/setup', pic.setupSent)
          const at = await $.clock.now()
          if (run !== pic.current) return
          pic.askedAt = at // the setup and the board paint a frame of their own
          const first = pic.board
          pic.offered = JSON.stringify(first)
          pic.coalescer.offer(first, at) // a fresh coalescer: the first offer always goes
          run.isFed = true
          await postBoard(run, first, at)
          const body = setupNow()
          if (run === pic.current && body !== pic.setupSent) {
            pic.setupSent = body
            await post(run, '/setup', body)
          }
        }
        /**
         * Starts a helper and reads it for the session's life. A loop that ends on its own, an E line, a helper that
         * prints no R within LISTEN_MS and a failed post are all the run's failure. A stale run leaves its loop at the
         * next piece, at the latest the helper's H a second later, and leaving the loop kills the child.
         */
        const start = (tag: string): void => {
          const run: Run = { tag, socket: socketPath(env, tag), isListening: false, isFed: false, hasEnded: false, hasFailed: false }
          pic.current = run
          pic.helper = 'starting'
          pic.paused = false
          pic.lastFrame = undefined
          pic.retries = 0
          pic.coalescer = new Coalescer<Board>()
          pic.offered = ''
          pic.setupSent = ''
          void quietly(async () => {
            let cause = 'the helper exited'
            try {
              // Two helpers never share a tag: one that outlived its run is ended first ("no process" is fine).
              await quietly(() => $.process.run(['pkill', '-TERM', '-f', run.socket], { timeoutMs: 5000 }))
              if (run !== pic.current) return
              const child = $.process.spawn({ argv: [bun, `${$.plugin.root}/helper/painter.ts`, run.socket, tag] })
              $.clock.after(LISTEN_MS, () => {
                if (run === pic.current && !run.isListening) void fail(run, `no R within ${LISTEN_MS / 1000} s`)
              })
              const reader = new LineReader()
              reading: for await (const piece of child) {
                if (run !== pic.current) break
                if (piece.stream !== 'stdout') continue
                for (const line of reader.push(piece.text)) {
                  if (run !== pic.current) break reading
                  if (line.kind === 'R') await ready(run)
                  else if (line.kind === 'F') relay(run, line)
                  else if (line.kind === 'S') pic.lastS = line.text
                  else {
                    pic.lastE = line.message
                    cause = `E ${line.message}`
                    break reading
                  }
                }
              }
            } catch (failure) {
              cause = oneLine(failure)
            } finally {
              run.hasEnded = true
            }
            await fail(run, cause) // nothing for a run the plugin had already ended
          })
        }
        /** What changed since the helper last heard: its setup, the board, a pause to lift, or no recent frame. */
        const feedHelper = (run: Run): void => {
          let isSending = false
          const body = setupNow()
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
            isSending = true
            void post(run, '/resume')
          } else if (!isSending && now - Math.max(pic.lastFAt, pic.askedAt) >= STALE_MS) {
            pic.askedAt = now
            isSending = true
            void post(run, '/frame')
          }
          // The frame this asks for may come before the Image this render returns is mounted.
          if (isSending) pic.renderAskedAt = now
        }

        source = await quietly(async () => {
          pic.board = state
          pic.rows = rowsAvailable
          if (pic.themeRow === undefined) {
            const config = await quietly(() => $.config.list())
            pic.themeRow = String(config?.find(row => row.key === 'theme')?.value ?? '')
          }
          const tag = (pic.tag ??= (await quietly(() => read($, tagRef))) || newTag(Math.random))
          const run = pic.current
          if (pic.helper === 'idle' || pic.helper === 'stopped') start(tag)
          else if (run?.isFed === true) feedHelper(run)
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

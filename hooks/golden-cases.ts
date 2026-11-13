// The cases that pin the desktop drawing: every board and option the drawing reacts to, at fixed ids and absolute times.
import type { Board, Entry, StationId } from '../types'

export type GoldenCase = { name: string; board: Board; now: number; options: Record<string, unknown> }

const NOW = 1_000_000

type Extra = Partial<Omit<Entry, 'id' | 'station' | 'startedAt' | 'status'>>

let serial = 0
/** An entry with a fixed id; `serial` restarts for each case, so ids depend on the case alone. */
function entry(station: StationId, startedAt: number, status: Entry['status'], extra: Extra = {}): Entry {
  serial++
  return { id: `e${serial}`, station, label: `${station} ${serial}`, from: 'core', startedAt, status, ...extra }
}

/** A finished call. */
const done = (station: StationId, startedAt: number, tookMs = 100, extra: Extra = {}): Entry =>
  entry(station, startedAt, 'ok', { endedAt: startedAt + tookMs, ...extra })

const board = (entries: Entry[], extra: Partial<Board> = {}): Board => {
  const counts: Partial<Record<StationId, number>> = {}
  for (const e of entries) counts[e.station] = (counts[e.station] ?? 0) + 1
  return { entries, counts, model: 'claude-opus-4-7', ...extra }
}

const ALL: StationId[] = ['you', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks']

function busy(): Board {
  serial = 0
  const stops: StationId[] = ['files', 'shell', 'web', 'browser', 'skills', 'hooks', 'files']
  const entries = stops.map((s, k) => done(s, NOW - 40000 + k * 3000))
  entries.push(
    done('shell', NOW - 1000, 800), // returning pulse, and a pulse still in flight
    done('web', NOW - 4000, 300, { from: 'agents' }),
    entry('web', NOW - 2500, 'err', { endedAt: NOW - 2000 }),
    entry('memory', NOW - 9000, 'run'), // the running call
    entry('memory', NOW - 600, 'ok', { from: 'inbound', endedAt: NOW - 500 }),
    entry('files', NOW - 300, 'run'), // a pulse in flight and a beam
  )
  return board(entries, {
    step: 4,
    pushed: 1,
    faults: { web: 1 },
    agents: ['a1', 'a2'],
    context: 72,
    switchedAt: NOW - 20000,
    counts: { files: 9, shell: 5, web: 3, memory: 4, browser: 1, skills: 1, hooks: 1 },
  })
}

function threshold(event: string, ms: number): GoldenCase[] {
  return ([['before', -1], ['after', 1]] as const).map(([side, d]) => {
    serial = 0
    const t = NOW - (ms + d)
    let entries: Entry[]
    let extra: Partial<Board> = {}
    switch (event) {
      case 'flight': entries = [entry('files', t, 'run')]; break
      case 'glow': entries = [entry('shell', t - 100, 'ok', { endedAt: t })]; break
      case 'alarm': entries = [entry('web', t - 100, 'err', { endedAt: t })]; break
      case 'switch':
        entries = [entry('model', t, 'ok', { endedAt: t, mark: 'switch' })]
        extra = { switchedAt: t }
        break
      case 'done': entries = [entry('you', t, 'ok', { endedAt: t, mark: 'done' })]; break
      case 'route': entries = [done('files', t - 2000), done('shell', t - 1000), done('web', t)]; break
      default: entries = [entry('skills', t, 'run')]
    }
    return { name: `t-${event}-${ms}-${side}`, board: board(entries, extra), now: NOW, options: {} }
  })
}

function boards(): GoldenCase[] {
  const make = (name: string, make: () => Board): GoldenCase => {
    serial = 0
    return { name: `board-${name}`, board: make(), now: NOW, options: {} }
  }
  const ctx = (n?: number) => () => board([done('files', NOW - 5000)], n === undefined ? {} : { context: n })
  return [
    make('empty', () => board([])),
    make('idle-faded', () => board([done('files', NOW - 100000), done('shell', NOW - 90000), done('web', NOW - 80000)])),
    make('lanes', () => board([entry('shell', NOW - 400, 'run'), entry('shell', NOW - 300, 'run'), entry('shell', NOW - 200, 'run')])),
    make('inbound', () => board([entry('memory', NOW - 300, 'ok', { from: 'inbound', endedAt: NOW - 200 })])),
    make('pushed-0', () => board([done('memory', NOW - 5000)], { counts: { memory: 3 }, pushed: 0 })),
    make('pushed-1', () => board([done('memory', NOW - 5000), done('memory', NOW - 4000)], { counts: { memory: 2 }, pushed: 1 })),
    make('times-3', () => board([done('files', NOW - 5000), done('files', NOW - 4000), done('files', NOW - 3000)])),
    make('faults-1', () => board([done('web', NOW - 5000)], { faults: { web: 1 } })),
    make('faults-120', () => board([done('web', NOW - 5000)], { faults: { web: 120 } })),
    make('context-none', ctx()),
    make('context-0', ctx(0)),
    make('context-69', ctx(69)),
    make('context-70', ctx(70)),
    make('context-90', ctx(90)),
    make('context-100', ctx(100)),
    make('no-model', () => ({ ...board([done('files', NOW - 5000)]), model: undefined })),
    make('crew-3', () => board([done('agents', NOW - 5000)], { agents: ['a1', 'a2', 'a3'] })),
    make('crew-6', () => board([done('agents', NOW - 5000)], { agents: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] })),
    make('blocked', () => board([entry('hooks', NOW - 2000, 'block', { endedAt: NOW - 1900 })])),
    make('from-agents', () => board([done('files', NOW - 600, 300, { from: 'agents', agentId: 'a1' })], { agents: ['a1'] })),
    make('all-running', () => board(ALL.map((s, k) => entry(s, NOW - 2000 - k * 500, 'run')))),
  ]
}

const SETUPS: [string, unknown][] = [
  ['theme', 'auto'], ['theme', 'dark'], ['theme', 'light'],
  ['layout', 'you-top'], ['layout', 'you-bottom'],
  ['background', 'solid'], ['background', 'transparent'],
  ['colors', ['node=#0a0c11']], ['colors', ['accent=#ff9900', 'text=#eeeeee']],
  ['language', 'en'], ['language', 'ru'], ['language', 'es'], ['language', 'fr'], ['language', 'de'],
  ['coreName', 'X'], ['coreName', 'ДОМ'], ['coreName', 'ABCDEFGHIJ'], ['coreName', '<&">'],
]
const SETUP_NAMES = [
  'theme-auto', 'theme-dark', 'theme-light', 'layout-you-top', 'layout-you-bottom',
  'background-solid', 'background-transparent', 'colors-dark-equal', 'colors-two',
  'language-en', 'language-ru', 'language-es', 'language-fr', 'language-de',
  'core-X', 'core-ДОМ', 'core-ABCDEFGHIJ', 'core-<&">',
]

export const GOLDEN_CASES: GoldenCase[] = [
  { name: 'busy-default', board: busy(), now: NOW, options: {} },
  ...[['flight', 1250], ['flight', 1600], ['glow', 3200], ['alarm', 6000],
    ['switch', 1600], ['switch', 3200], ['switch', 4800], ['switch', 6400], ['switch', 8000],
    ['done', 1100], ['route', 40000], ['route', 60000], ['hands', 60000], ['hands', 600000],
  ].flatMap(([e, ms]) => threshold(e as string, ms as number)),
  ...boards(),
  ...SETUPS.map(([key, value], i): GoldenCase => ({
    name: `setup-${SETUP_NAMES[i]}`,
    board: busy(),
    now: NOW,
    options: { [key as string]: value },
  })),
]

/** 64-bit FNV-1a over the UTF-16 code units, as 16 hex digits. */
export function fingerprint(text: string): string {
  let h = 0xcbf29ce484222325n
  for (let i = 0; i < text.length; i++) h = BigInt.asUintN(64, (h ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n)
  return h.toString(16).padStart(16, '0')
}

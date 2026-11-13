// The board as a scene: every element of the drawing, with its tag and attributes written exactly as the SVG has them,
// plus what a pixel painter needs besides: how fast each animation changes, and which cached layer each element joins.
// Nothing here touches the engine.
import type { Board, Entry, StationId } from '../types'
import { STATIONS, shortModel } from './map'
import type { Setup } from './map'
import { DARK, LIGHT, lightRules } from './palette'
import type { Palette } from './palette'
import type { Strings } from './text'

/** `fast`: a finite animation that moves geometry. `slow`: a loop that never ends, or a long fade of opacity alone. */
export type MotionClass = 'fast' | 'slow'

/**
 * One element. Its attributes are today's names and strings, in today's order; text children are already escaped.
 * `group` is set on top-level nodes only, for the pixel painter's cache; the SVG painter ignores it.
 */
export type SceneNode = {
  tag: string
  attrs: readonly (readonly [string, string])[]
  children?: readonly (SceneNode | string)[]
  motion?: MotionClass
  isRestingBreath?: true
  group?: string
}

/** What `drawMap` draws, before it is written as SVG. `style` is the light rules for `auto`, or nothing. */
export type Scene = { now: number; width: number; height: number; style: string; nodes: readonly SceneNode[]; isAnyRunning: boolean }

const W = 460
const H = 430
const CX = 230
const CY = 212
const RX = 176
const RY = 164
const NODE = 22
const CORE = 40
/** Where spokes and pulses meet the core: outside the context ring. */
const HUB = CORE + 8

const PULSE_MS = 800
const RIPPLE_MS = 450
const GLOW_MS = 3200
const ALARM_MS = 6000
const SWITCH_MS = 8000
const DONE_MS = 1100
const TRAIL_STOPS = 7
/** A leg of the route stays for a while after it was drawn, then fades: the route shows where the work is going, and the spokes keep where it went. */
export const TRAIL_HOLD_MS = 40_000
export const TRAIL_FADE_MS = 20_000

type Point = { x: number; y: number }

// ---- nodes ------------------------------------------------------------------------------------

/** Attributes as written. No name here reads as a number, so an object keeps the order they are given in. */
type Attrs = Record<string, string | number>

function pairs(a: Attrs): [string, string][] {
  const out: [string, string][] = []
  for (const k in a) out.push([k, String(a[k])])
  return out
}

/** An element. Without children it closes itself, as `<circle …/>`; with them, even an empty text, it has an end tag. */
function el(tag: string, a: Attrs, children?: (SceneNode | string)[]): SceneNode {
  return children === undefined ? { tag, attrs: pairs(a) } : { tag, attrs: pairs(a), children }
}

const animate = (motion: MotionClass, a: Attrs, tag = 'animate'): SceneNode => ({ tag, attrs: pairs(a), motion })

/** Puts fresh top-level nodes in a group. */
function grouped(group: string, nodes: SceneNode[]): SceneNode[] {
  for (const n of nodes) n.group = group
  return nodes
}

const FONT: Attrs = { 'font-family': 'SF Mono, ui-monospace, Menlo, monospace' }

// ---- geometry ---------------------------------------------------------------------------------

/** How many places the ring is turned. The stations keep their order, so the far side of the person is always the network. */
let shift = 0
const turn = (i: number): number => ((i + shift) * 2 * Math.PI) / STATIONS.length
const at = (a: number, f = 1): Point => ({ x: CX + RX * f * Math.sin(a), y: CY - RY * f * Math.cos(a) })
const place = (i: number): Point => at(turn(i))
const indexOf = (id: StationId): number => STATIONS.findIndex(s => s.id === id)

const n1 = (v: number): string => (Math.round(v * 10) / 10).toString()
/** A moment on the drawing's own clock, which starts at zero each time it is drawn; a past moment is negative. */
const clock = (ms: number): string => `${(ms / 1000).toFixed(3)}s`

/** Where a straight line from `from` to `to` meets the circle of radius `r` around `from`. */
function edge(from: Point, to: Point, r: number): Point {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}

/** The same line moved sideways, so that several pulses on one spoke fly side by side. */
function aside(a: Point, b: Point, off: number): [Point, Point] {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
  const dx = (-(b.y - a.y) * off) / d
  const dy = ((b.x - a.x) * off) / d
  return [{ x: a.x + dx, y: a.y + dy }, { x: b.x + dx, y: b.y + dy }]
}

// ---- what moves -------------------------------------------------------------------------------

/** A pulse with a short tail behind it. A hollow one is a signal nobody asked for. */
function pulse(a: Point, b: Point, color: string, age: number, radius: number, isHollow = false): SceneNode[] {
  // A negative begin carries on where the last drawing left off, so a redraw never restarts a flight.
  const path = `M${n1(a.x)} ${n1(a.y)}L${n1(b.x)} ${n1(b.y)}`
  const out: SceneNode[] = []
  for (let k = isHollow ? 0 : 2; k >= 0; k--) {
    const timing = { begin: clock(k * 45 - age), dur: clock(PULSE_MS), fill: 'freeze' }
    const peak = n1(1 - 0.36 * k)
    const paint: Attrs = isHollow ? { fill: 'none', stroke: color, 'stroke-width': '1.4' } : { fill: color }
    out.push(
      el('circle', { r: n1(radius * (1 - 0.27 * k)), ...paint, opacity: '0' }, [
        animate('fast', { path, ...timing }, 'animateMotion'),
        animate('fast', { attributeName: 'opacity', values: `${peak};${peak};0`, keyTimes: '0;.82;1', ...timing }),
      ]),
    )
  }
  return out
}

/** A ring that spreads from where a pulse lands, at the moment it lands. */
function ripple(p: Point, r: number, color: string, age: number): SceneNode {
  const timing = { begin: clock(PULSE_MS - age), dur: clock(RIPPLE_MS), fill: 'freeze' }
  return el('circle', { cx: n1(p.x), cy: n1(p.y), r, fill: 'none', stroke: color, 'stroke-width': '1.2', opacity: '0' }, [
    animate('fast', { attributeName: 'r', values: `${r};${r + 11}`, ...timing }),
    animate('fast', { attributeName: 'opacity', values: '.7;0', ...timing }),
  ])
}

function beam(a: Point, b: Point, color: string, age: number, isDashed: boolean): SceneNode {
  return el(
    'line',
    { x1: n1(a.x), y1: n1(a.y), x2: n1(b.x), y2: n1(b.y), stroke: color, 'stroke-width': '1.4', ...(isDashed ? { 'stroke-dasharray': '3 4' } : {}), opacity: '0' },
    [animate('slow', { attributeName: 'opacity', values: '.75;0', begin: clock(-age), dur: clock(GLOW_MS / 2), fill: 'freeze' })],
  )
}

// ---- the route --------------------------------------------------------------------------------

/** How far from the core a leg bends, by how many stations apart its ends are: far enough in to clear the labels under the nodes, far enough out to clear the core. */
const BEND = [0.5, 0.5, 0.4, 0.45, 0.55, 0.75]

/** The way from one station to another: a curve through the room between the core and the ring. */
function leg(i: number, j: number): { path: string; end: Point } {
  const n = STATIONS.length
  let steps = (((j - i) % n) + n) % n
  if (steps > n / 2) steps -= n
  const bend = at(turn(i + steps / 2), BEND[Math.abs(steps)] ?? 0.5)
  const a = edge(place(i), bend, NODE + 4)
  const b = edge(place(j), bend, NODE + 4)
  return { path: `M${n1(a.x)} ${n1(a.y)}Q${n1(bend.x)} ${n1(bend.y)} ${n1(b.x)} ${n1(b.y)}`, end: b }
}

/** The stations the main loop went through, oldest first, a station visited twice in a row counted once. */
export function routeOf(entries: readonly Entry[], max = TRAIL_STOPS): { station: StationId; at: number }[] {
  const stops: { station: StationId; at: number }[] = []
  for (const e of entries) {
    if (e.from === 'agents' || e.station === 'model') continue
    const last = stops[stops.length - 1]
    if (last !== undefined && last.station === e.station) last.at = e.startedAt
    else stops.push({ station: e.station, at: e.startedAt })
  }
  return stops.slice(-max)
}

/** Each leg k of the route, in group `route:<k>`, the newest with the dot at its end. */
function trail(entries: readonly Entry[], now: number, c: Palette): SceneNode[] {
  const stops = routeOf(entries)
  const out: SceneNode[] = []
  for (let k = 1; k < stops.length; k++) {
    const from = stops[k - 1]
    const to = stops[k]
    if (from === undefined || to === undefined) continue
    const { path, end } = leg(indexOf(from.station), indexOf(to.station))
    const isHead = k === stops.length - 1
    const age = now - to.at
    if (age >= TRAIL_HOLD_MS + TRAIL_FADE_MS) continue
    const opacity = n1(0.12 + (0.5 * k) / (stops.length - 1))
    // The fading is written into the drawing, so a leg goes out on time even when nothing redraws the map.
    const fade = animate('slow', { attributeName: 'opacity', values: `${opacity};0`, begin: clock(TRAIL_HOLD_MS - age), dur: clock(TRAIL_FADE_MS), fill: 'freeze' })
    const line: Attrs = { d: path, fill: 'none', stroke: c.trail, 'stroke-width': isHead ? 1.5 : 1.1, 'stroke-linecap': 'round', opacity }
    // The newest leg draws itself; the rest are already there.
    const nodes = [
      isHead
        ? el('path', { ...line, pathLength: '1', 'stroke-dasharray': '1 1', 'stroke-dashoffset': '1' }, [
            animate('fast', { attributeName: 'stroke-dashoffset', values: '1;0', begin: clock(to.at - now), dur: '.5s', fill: 'freeze' }),
            fade,
          ])
        : el('path', line, [fade]),
    ]
    if (isHead) {
      nodes.push(
        el('circle', { cx: n1(end.x), cy: n1(end.y), r: '2.4', fill: c.trail, opacity: '0' }, [
          animate('fast', { attributeName: 'opacity', values: '0;.85', begin: clock(to.at - now + 400), dur: '.15s', fill: 'freeze' }),
          animate('slow', { attributeName: 'opacity', values: '.85;0', begin: clock(TRAIL_HOLD_MS - age), dur: clock(TRAIL_FADE_MS), fill: 'freeze' }),
        ]),
      )
    }
    out.push(...grouped(`route:${k}`, nodes))
  }
  return out
}

// ---- the stations -----------------------------------------------------------------------------

type Context = { entries: Entry[]; board: Board; now: number; c: Palette; names: Strings['stations'] }

/** A station's nodes: what lies under the pulses (glow, beat, hands) and what lies over them (the node and its words). */
function station(s: (typeof STATIONS)[number], i: number, { entries, board, now, c, names }: Context): { under: SceneNode[]; over: SceneNode[] } {
  const p = place(i)
  const x = n1(p.x)
  const y = n1(p.y)
  const count = board.counts[s.id] ?? 0
  const own = entries.filter(e => e.station === s.id)
  const running = own.filter(e => e.status === 'run')
  const latest = own.length > 0 ? own[own.length - 1] : undefined
  const since = latest === undefined ? Infinity : now - (latest.endedAt ?? latest.startedAt)
  const alarm = own.filter(e => e.status === 'block' || e.status === 'err').pop()
  const alarmAge = alarm === undefined ? Infinity : now - (alarm.endedAt ?? alarm.startedAt)
  const isAlarm = alarmAge < ALARM_MS
  const isLit = running.length > 0 || since < GLOW_MS
  const [main, hot] = s.id === 'memory' ? [c.mem, c.memHot] : [c.accent, c.hot]
  const color = isAlarm ? c.red : main
  const fade = isAlarm ? alarmAge : since
  const span = isAlarm ? ALARM_MS : GLOW_MS

  const under: SceneNode[] = []
  if (isLit || isAlarm) {
    under.push(
      running.length > 0 && !isAlarm
        ? el('circle', { cx: x, cy: y, r: NODE + 10, fill: color, opacity: '.16' })
        : el('circle', { cx: x, cy: y, r: NODE + 10, fill: color, opacity: '0' }, [
            animate('slow', { attributeName: 'opacity', values: '.3;0', begin: clock(-fade), dur: clock(span), fill: 'freeze' }),
          ]),
    )
  }
  if (running.length > 0) {
    const elapsed = now - Math.min(...running.map(e => e.startedAt))
    const beat = { begin: clock(-(elapsed % 1400)), dur: '1.4s', repeatCount: 'indefinite' }
    under.push(
      el('circle', { cx: x, cy: y, r: NODE, fill: 'none', stroke: color, 'stroke-width': '1.3' }, [
        animate('slow', { attributeName: 'r', values: `${NODE};${NODE + 15}`, ...beat }),
        animate('slow', { attributeName: 'opacity', values: '.9;0', ...beat }),
      ]),
    )
    // Two hands of a clock around the node: the inner one goes round in a minute, the outer one in ten.
    const hand = (r: number, width: number, lapMs: number, isOnce: boolean): SceneNode =>
      el(
        'circle',
        { cx: x, cy: y, r, fill: 'none', stroke: hot, 'stroke-width': width, pathLength: '1', 'stroke-dasharray': '1 1', 'stroke-dashoffset': '1', transform: `rotate(-90 ${x} ${y})` },
        [
          animate('slow', {
            attributeName: 'stroke-dashoffset',
            values: '1;0',
            begin: clock(-(isOnce ? Math.min(elapsed, lapMs) : elapsed % lapMs)),
            dur: clock(lapMs),
            ...(isOnce ? { fill: 'freeze' } : { repeatCount: 'indefinite' }),
          }),
        ],
      )
    under.push(hand(NODE + 4, 2.2, 60_000, false), hand(NODE + 8, 1.2, 600_000, true))
  }

  // A lit node wears a ring of its color while something runs; afterwards the ring fades back to the resting line.
  const lit: Attrs = { cx: x, cy: y, r: NODE, fill: 'none', stroke: color, 'stroke-width': '1.2' }
  const cooling =
    running.length > 0
      ? [el('circle', lit)]
      : isLit || isAlarm
        ? [el('circle', { ...lit, opacity: '0' }, [animate('slow', { attributeName: 'opacity', values: '1;0', begin: clock(-fade), dur: clock(span), fill: 'freeze' })])]
        : []
  const glyphColor = isAlarm ? c.red : isLit ? hot : s.id === 'memory' && count > 0 ? main : c.ash
  // The words stand on a rim of the ground's own color, so a line that passes behind them never strikes them through.
  const rim: Attrs = { 'paint-order': 'stroke', stroke: c.ground, 'stroke-width': '3.5', 'stroke-linejoin': 'round' }
  const over: SceneNode[] = [
    el('circle', { cx: x, cy: y, r: NODE, fill: c.raised, stroke: c.line, 'stroke-width': '1.2' }),
    ...cooling,
    el('path', { transform: `translate(${x} ${y})`, d: s.icon, fill: 'none', stroke: glyphColor, 'stroke-width': '1.25', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    el('text', { x, y: n1(p.y + NODE + 15), 'text-anchor': 'middle', ...FONT, 'font-size': '11.5', ...rim, fill: isLit || isAlarm ? c.bone : c.ash }, [names[s.id]]),
  ]

  if (count > 0) {
    // Memory keeps two counts: what was asked for, and what a hook brought down unasked.
    const pushed = s.id === 'memory' ? Math.min(count, board.pushed ?? 0) : 0
    const asked = count - pushed
    const figures: (SceneNode | string)[] =
      pushed === 0 ? [String(count)] : [...(asked > 0 ? [`${asked} `] : []), el('tspan', { fill: main }, [`↓${pushed}`])]
    over.push(el('text', { x, y: n1(p.y + NODE + 28), 'text-anchor': 'middle', ...FONT, 'font-size': '9.5', ...rim, fill: c.dim }, figures))
  }

  // Top right: how many run at once. Top left: what went wrong since the last message, until the next one.
  const corner = NODE * 0.74
  if (running.length > 1) {
    over.push(
      el('circle', { cx: n1(p.x + corner), cy: n1(p.y - corner), r: '8', fill: c.raised, stroke: color, 'stroke-width': '1' }),
      el('text', { x: n1(p.x + corner), y: n1(p.y - corner + 3), 'text-anchor': 'middle', ...FONT, 'font-size': '8.5', fill: hot }, [`×${running.length}`]),
    )
  }
  const faults = board.faults?.[s.id] ?? 0
  if (faults > 0) {
    over.push(
      el('circle', { cx: n1(p.x - corner), cy: n1(p.y - corner), r: '7.5', fill: c.red }),
      el('text', { x: n1(p.x - corner), y: n1(p.y - corner + 3.1), 'text-anchor': 'middle', ...FONT, 'font-size': '9', 'font-weight': '700', fill: c.ground }, [
        String(faults > 99 ? '99+' : faults),
      ]),
    )
  }
  return { under: grouped(`station:${s.id}`, under), over: grouped(`station:${s.id}`, over) }
}

// ---- the scene --------------------------------------------------------------------------------

export function sceneOf(board: Board, now: number, setup: Setup): Scene {
  shift = setup.layout === 'you-bottom' ? STATIONS.length / 2 : 0
  const c: Palette = { ...(setup.theme === 'light' ? LIGHT : DARK), ...setup.colors }
  const core: Point = { x: CX, y: CY }
  const recent = board.entries.slice(-40)
  const flights = recent.filter(e => now - e.startedAt < PULSE_MS + RIPPLE_MS).slice(-14)
  const returns = recent.filter(e => e.endedAt !== undefined && e.from !== 'inbound' && now - e.endedAt < PULSE_MS + RIPPLE_MS).slice(-14)
  const beams = recent.filter(e => now - e.startedAt < GLOW_MS / 2).slice(-10)
  const anyRunning = recent.some(e => e.status === 'run')
  const agentsAt = place(indexOf('agents'))
  const isBad = (e: Entry): boolean => e.status === 'block' || e.status === 'err'
  const tone = (e: Entry): [string, string] => (e.station === 'memory' ? [c.mem, c.memHot] : [c.accent, c.hot])
  const nodes: SceneNode[] = []

  // Without its ground the map keeps the rim around its words, in the ground's color: a faint halo on a surface of another shade.
  const ground: SceneNode[] = setup.background === 'transparent' ? [] : [el('rect', { width: W, height: H, rx: '12', fill: c.ground })]

  // Contours around the core.
  for (const [rx, ry] of [[66, 62], [104, 97], [142, 132]] as const) {
    ground.push(el('ellipse', { cx: CX, cy: CY, rx, ry, fill: 'none', stroke: c.line, 'stroke-width': '.7', opacity: '.45', 'stroke-dasharray': '2 5' }))
  }
  nodes.push(...grouped('ground', ground))

  // Spokes first, then whatever flies along them, then the nodes on top.
  // A spoke wears in with use: by the end of a session the map shows where the work went.
  STATIONS.forEach((s, i) => {
    const p = place(i)
    const a = edge(core, p, HUB)
    const b = edge(p, core, NODE)
    const worn = Math.min(1, Math.log2(1 + (board.counts[s.id] ?? 0)) / 7)
    const line: Attrs = { x1: n1(a.x), y1: n1(a.y), x2: n1(b.x), y2: n1(b.y), 'stroke-width': n1(1 + 2.6 * worn), 'stroke-linecap': 'round' }
    const spoke = [el('line', { ...line, stroke: c.spoke })]
    if (worn > 0) spoke.push(el('line', { ...line, stroke: s.id === 'memory' ? c.mem : c.accent, opacity: n1(worn * 0.55) }))
    nodes.push(...grouped(`spoke:${s.id}`, spoke))
  })

  const context: Context = { entries: recent, board, now, c, names: setup.t.stations }
  const drawn = STATIONS.map((s, i) => station(s, i, context))
  for (const d of drawn) nodes.push(...d.under)
  nodes.push(...trail(recent, now, c))

  /** The two ends of an entry's spoke: where it starts (the core or the agents station) and its own station. */
  const ends = (e: Entry): [Point, Point] => {
    const p = place(indexOf(e.station))
    const start = e.from === 'agents' ? agentsAt : core
    return [edge(start, p, e.from === 'agents' ? NODE : HUB), edge(p, start, NODE)]
  }
  /** Pulses that share a spoke and a moment fly in lanes, five apart. */
  const lane = (list: Entry[], e: Entry): number => {
    const peers = list.filter(x => x.station === e.station && x.from === e.from)
    return (peers.indexOf(e) - (peers.length - 1) / 2) * 5
  }

  const motion: SceneNode[] = []
  for (const e of beams) {
    const [a, b] = ends(e)
    motion.push(beam(a, b, isBad(e) ? c.red : tone(e)[0], now - e.startedAt, e.from === 'inbound'))
  }
  for (const e of flights) {
    const [a, b] = aside(...ends(e), lane(flights, e))
    const age = now - e.startedAt
    const color = e.status === 'block' ? c.red : tone(e)[1]
    if (e.from === 'inbound') {
      motion.push(...pulse(b, a, color, age, 3.8, true), ripple(core, HUB - 2, color, age))
    } else {
      motion.push(...pulse(a, b, color, age, 3.8), ripple(place(indexOf(e.station)), NODE, color, age))
    }
  }
  for (const e of returns) {
    const [a, b] = aside(...ends(e), lane(returns, e))
    motion.push(...pulse(b, a, e.status === 'ok' ? c.ash : c.red, now - (e.endedAt as number), 2.6))
  }
  nodes.push(...grouped('motion', motion))

  for (const d of drawn) nodes.push(...d.over)

  // Each subagent still at work circles the agents station.
  const crew = (board.agents ?? []).slice(0, 6)
  crew.forEach((_, k) => {
    const lap = 7000
    const spin = `${n1(agentsAt.x)} ${n1(agentsAt.y)}`
    nodes.push(
      ...grouped('crew', [
        el('g', {}, [
          animate(
            'slow',
            { attributeName: 'transform', type: 'rotate', from: `0 ${spin}`, to: `360 ${spin}`, begin: clock(-((now + (k * lap) / crew.length) % lap)), dur: clock(lap), repeatCount: 'indefinite' },
            'animateTransform',
          ),
          el('circle', { cx: n1(agentsAt.x), cy: n1(agentsAt.y - NODE - 6), r: '3', fill: c.hot }),
        ]),
      ]),
    )
  })

  // A name longer than three letters shrinks to stay inside the circle.
  const coreSize = Math.min(17, 62 / (0.75 * setup.core.length))

  // The core breathes at rest and quickens while something runs.
  const period = anyRunning ? 1600 : 4800
  const breath = { begin: clock(-(now % period)), dur: clock(period), repeatCount: 'indefinite' }
  const centre: SceneNode[] = [
    {
      ...el('circle', { cx: CX, cy: CY, r: CORE + 6, fill: c.accent, opacity: '.08' }, [
        animate('slow', { attributeName: 'r', values: `${CORE + 3};${CORE + 13};${CORE + 3}`, ...breath }),
        animate('slow', { attributeName: 'opacity', values: `.05;${anyRunning ? '.24' : '.12'};.05`, ...breath }),
      ]),
      isRestingBreath: true,
    },
    el('circle', { cx: CX, cy: CY, r: CORE, fill: c.raised, stroke: anyRunning ? c.accent : c.line, 'stroke-width': '1.3' }),
  ]

  // The context window as a ring around the core: it fills as the session goes and empties at a compaction.
  if (board.context !== undefined) {
    const full = Math.max(0, Math.min(100, Math.round(board.context)))
    const ring: Attrs = { cx: CX, cy: CY, r: CORE + 5, fill: 'none', 'stroke-width': '2.2' }
    centre.push(
      el('circle', { ...ring, stroke: c.line, opacity: '.7' }),
      el('circle', { ...ring, stroke: full >= 90 ? c.red : full >= 70 ? c.accent : c.ash, pathLength: '100', 'stroke-dasharray': `${full} 100`, transform: `rotate(-90 ${CX} ${CY})` }),
      el('text', { x: CX, y: CY - 19, 'text-anchor': 'middle', ...FONT, 'font-size': '8', fill: c.dim }, [`${full}%`]),
    )
  }

  const switchAge = board.switchedAt === undefined ? Infinity : now - board.switchedAt
  const isSwitching = switchAge >= 0 && switchAge < SWITCH_MS
  centre.push(
    el('text', { x: CX, y: CY + (board.model === undefined ? 6 : 1), 'text-anchor': 'middle', ...FONT, 'font-size': n1(coreSize), 'letter-spacing': n1(coreSize * 0.147), fill: c.bone }, [
      escapeXml(setup.core),
    ]),
  )
  if (board.model !== undefined) {
    centre.push(el('text', { x: CX, y: CY + 17, 'text-anchor': 'middle', ...FONT, 'font-size': '9', fill: isSwitching ? c.hot : c.ash }, [escapeXml(shortModel(board.model))]))
  }
  nodes.push(...grouped('core', centre))

  const rings: SceneNode[] = []
  // A changed model rings at the core and at its station for a few seconds.
  if (isSwitching) {
    const model = place(indexOf('model'))
    const laps = Math.ceil((SWITCH_MS - switchAge) / 1600)
    for (const [p, r] of [[core, CORE], [model, NODE]] as const) {
      const ringing = { begin: clock(-(switchAge % 1600)), dur: '1.6s', repeatCount: laps, fill: 'freeze' }
      rings.push(
        el('circle', { cx: n1(p.x), cy: n1(p.y), r, fill: 'none', stroke: c.bone, 'stroke-width': '1.4', opacity: '0' }, [
          animate('fast', { attributeName: 'r', values: `${r};${r + 26}`, ...ringing }),
          animate('fast', { attributeName: 'opacity', values: '.7;0', ...ringing }),
        ]),
      )
    }
  }

  // The answer leaves the core as one wide ring.
  const done = recent.filter(e => e.mark === 'done').pop()
  if (done !== undefined && now - done.startedAt < DONE_MS) {
    const leaving = { begin: clock(done.startedAt - now), dur: clock(DONE_MS), fill: 'freeze' }
    rings.push(
      el('circle', { cx: CX, cy: CY, r: CORE, fill: 'none', stroke: c.bone, 'stroke-width': '1.6', opacity: '0' }, [
        animate('fast', { attributeName: 'r', values: `${CORE};${CORE + 38}`, ...leaving }),
        animate('fast', { attributeName: 'opacity', values: '.6;0', ...leaving }),
      ]),
    )
  }
  nodes.push(...grouped('rings', rings))

  return { now, width: W, height: H, style: setup.theme === 'auto' ? lightRules(setup.colors) : '', nodes, isAnyRunning: anyRunning }
}

function escapeXml(text: string): string {
  return text.replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c] as string)
}

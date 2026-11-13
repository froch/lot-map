// What an element's SMIL animations say at one moment. Pure evaluation: no drawing, no clock of its own.
import type { SceneNode } from '../scene'
import type { Point } from './path'

export type Sampled = { values: Map<string, number>; offset?: Point; rotate?: { degrees: number; cx: number; cy: number } }

/** `"0.800s"`, `"-1.234s"`, `".5s"` to milliseconds. */
export function parseClock(text: string): number {
  return Math.round(parseFloat(text) * 1000)
}

const ANIMATIONS = new Set(['animate', 'animateMotion', 'animateTransform'])
const isAnimation = (n: SceneNode | string): n is SceneNode => typeof n !== 'string' && ANIMATIONS.has(n.tag)

function attr(n: SceneNode, name: string): string | undefined {
  for (const [k, v] of n.attrs) if (k === name) return v
  return undefined
}

const numbers = (text: string): number[] => (text.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number)

type Timing = { begin: number; dur: number; laps: number }

function timingOf(anim: SceneNode, sceneNow: number): Timing {
  const rc = attr(anim, 'repeatCount')
  const laps = rc === undefined ? 1 : rc === 'indefinite' ? Infinity : Number(rc)
  return { begin: sceneNow + parseClock(attr(anim, 'begin') ?? '0s'), dur: parseClock(attr(anim, 'dur') ?? '0s'), laps }
}

function listOf(anim: SceneNode): string[] {
  const values = attr(anim, 'values')
  if (values !== undefined) return values.split(';').map((s) => s.trim())
  return [attr(anim, 'from') ?? '', attr(anim, 'to') ?? '']
}

/** The absolute span over which the animation's value changes. */
export function windowOf(anim: SceneNode, sceneNow: number): { from: number; to: number } {
  const { begin, dur, laps } = timingOf(anim, sceneNow)
  if (anim.tag === 'animate') {
    const list = listOf(anim)
    if (list.every((v) => v === list[0])) return { from: begin, to: begin }
  }
  return { from: begin, to: laps === Infinity ? Infinity : begin + laps * dur }
}

/** Progress 0..1 through one lap at time t, or undefined when the animation does not apply. */
function progressAt(anim: SceneNode, sceneNow: number, t: number): number | undefined {
  const { begin, dur, laps } = timingOf(anim, sceneNow)
  if (t < begin || dur <= 0) return undefined
  const local = t - begin
  if (local >= laps * dur) {
    if (attr(anim, 'fill') !== 'freeze') return undefined
    return Number.isInteger(laps) ? 1 : laps % 1
  }
  return (local % dur) / dur
}

/** Linear interpolation over `n` stops, spaced by keyTimes when given. */
function locate(p: number, n: number, keyTimes: number[] | undefined): { i: number; f: number } {
  if (n < 2) return { i: 0, f: 0 }
  const keys = keyTimes && keyTimes.length === n ? keyTimes : Array.from({ length: n }, (_, i) => i / (n - 1))
  if (p >= keys[n - 1]) return { i: n - 2, f: 1 }
  let i = 0
  while (i < n - 2 && p >= keys[i + 1]) i++
  const span = keys[i + 1] - keys[i]
  return { i, f: span > 0 ? Math.max(0, (p - keys[i]) / span) : 0 }
}

const mix = (a: number, b: number, f: number): number => a + (b - a) * f

/** Evaluates `node`'s own animation children at absolute time `t`. A `begin` is relative to `sceneNow`. */
export function sample(node: SceneNode, sceneNow: number, t: number): Sampled {
  const out: Sampled = { values: new Map() }
  const begun = new Map<string, number>()
  let motionBegin = -Infinity
  let rotateBegin = -Infinity
  for (const child of node.children ?? []) {
    if (!isAnimation(child)) continue
    const p = progressAt(child, sceneNow, t)
    if (p === undefined) continue
    const begin = timingOf(child, sceneNow).begin
    if (child.tag === 'animateMotion') {
      const [x1, y1, x2, y2] = numbers(attr(child, 'path') ?? '')
      if (y2 === undefined || begin < motionBegin) continue
      motionBegin = begin
      out.offset = { x: mix(x1, x2, p) + 0, y: mix(y1, y2, p) + 0 }
    } else if (child.tag === 'animateTransform') {
      if (attr(child, 'type') !== 'rotate' || begin < rotateBegin) continue
      const a = numbers(attr(child, 'from') ?? '')
      const b = numbers(attr(child, 'to') ?? '')
      if (a.length < 1 || b.length < 1) continue
      rotateBegin = begin
      out.rotate = { degrees: mix(a[0], b[0], p), cx: mix(a[1] ?? 0, b[1] ?? 0, p), cy: mix(a[2] ?? 0, b[2] ?? 0, p) }
    } else {
      const name = attr(child, 'attributeName')
      if (name === undefined) continue
      const stops = listOf(child).map(Number)
      if (stops.length === 0 || stops.some(Number.isNaN)) continue
      const kt = attr(child, 'keyTimes')
      const { i, f } = locate(p, stops.length, kt === undefined ? undefined : kt.split(';').map(Number))
      if ((begun.get(name) ?? -Infinity) > begin) continue
      begun.set(name, begin)
      out.values.set(name, stops.length < 2 ? stops[0] : mix(stops[i], stops[i + 1], f))
    }
  }
  return out
}

/** True when any animation at any depth below `node` has a window holding `t`. */
export function isChanging(node: SceneNode, sceneNow: number, t: number): boolean {
  for (const child of node.children ?? []) {
    if (typeof child === 'string') continue
    if (isAnimation(child)) {
      const w = windowOf(child, sceneNow)
      if (t >= w.from && t < w.to) return true
    } else if (isChanging(child, sceneNow, t)) return true
  }
  return false
}

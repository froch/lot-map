// The scene as pixels, sized to the pane. Each animation is sampled at a moment t; what does not change at t is
// kept in cached layers, one run of a group at a time, so a frame paints only what moves.
// Nothing here touches the engine.
import { lightPairs } from '../palette'
import type { Palette } from '../palette'
import type { Scene, SceneNode } from '../scene'
import { Canvas, parseColor } from './canvas'
import type { Rgb } from './canvas'
import type { FontFace } from './font'
import { FONT, TEXT_SCALE } from './font-data'
import { circle, dashed, ellipse, fill, line, multiply, parsePath, rotateAbout, roundRect, scale, stroke, translate } from './path'
import type { Matrix, Polyline } from './path'
import { drawText } from './text'
import type { TextRun, TextSpec } from './text'
import { isChanging, sample } from './timeline'
import type { Sampled } from './timeline'

/** The picture in pixels, and how many pixels a unit of the scene's 460×430 is. */
export type Picture = { width: number; height: number; scale: number }

/** `light` remaps the dark palette as desktop's light rules do; `colors` are the person's own (`setup.colors`), which stay. */
export type PaintOptions = { light: boolean; colors: Partial<Palette> }

/** The picture for a ring box `rows` tall: 34 px a row, between 408 and 1000 px, in the scene's proportions. */
export function pictureFor(rows: number): Picture {
  const height = Math.min(1000, Math.max(408, rows * 34))
  return { width: Math.round((height * 460) / 430), height, scale: height / 430 }
}

// ---- the cache --------------------------------------------------------------------------------

/** A run's pixels in a canvas the size of its bounding box, at (x, y) in the picture; `spans` are each row's inked [from, to). */
type Layer = { canvas: Canvas; x: number; y: number; spans: Int32Array }

type State = {
  bound: string
  layers: Map<string, Layer>
  pairs: Map<string, string> | undefined
  frame: Canvas | undefined
  repainted: string[]
}

const states = new WeakMap<LayerCache, State>()

const boundOf = (p: Picture, o: PaintOptions): string =>
  `${p.width}x${p.height}@${p.scale}|${o.light ? 'light' : 'dark'}|${Object.keys(o.colors).sort().map(k => `${k}=${o.colors[k as keyof Palette]}`).join(',')}`

const fresh = (picture: Picture, options: PaintOptions, repainted: string[]): State => ({
  bound: boundOf(picture, options),
  layers: new Map(),
  pairs: options.light ? lightPairs(options.colors) : undefined,
  frame: undefined,
  repainted,
})

/**
 * The layers of the last frame, for one picture size and one set of options. A paint with another size or other
 * options starts it afresh. With a cache, `paintScene` paints into a canvas the cache keeps and returns it again
 * at the next call, so a frame's pixels are valid until then.
 */
export class LayerCache {
  /** Keys of the layers the last `paintScene` built afresh. Changing nodes, painted each frame, are not listed. */
  readonly repainted: string[] = []

  constructor(picture: Picture, options: PaintOptions) {
    states.set(this, fresh(picture, options, this.repainted))
  }

  /** How many layers the cache holds. */
  get size(): number {
    return states.get(this)!.layers.size
  }
}

function stateFor(cache: LayerCache, picture: Picture, options: PaintOptions): State {
  const state = states.get(cache)!
  if (state.bound === boundOf(picture, options)) return state
  const next = fresh(picture, options, cache.repainted)
  states.set(cache, next)
  return next
}

// ---- painting a frame -------------------------------------------------------------------------

/** A run of top-level nodes of one group, none of them changing at t: one cached layer. */
type Run = { kind: 'layer'; group: string; nodes: SceneNode[]; samples: Map<SceneNode, Sampled>; key: string }
/** A node whose animations change at t: painted straight onto the frame. */
type Direct = { kind: 'direct'; node: SceneNode }

/**
 * The scene at moment t. Top-level nodes are split into runs at each change of group and at each node that changes
 * at t; a run is a cached layer, a changing node is painted each frame. Without a cache the same layers are built
 * afresh, so both ways give the same bytes. With a cache, the canvas returned is the cache's own, painted over by
 * the next call.
 */
export function paintScene(scene: Scene, t: number, picture: Picture, options: PaintOptions, cache?: LayerCache): Canvas {
  const state = cache === undefined ? fresh(picture, options, []) : stateFor(cache, picture, options)
  state.repainted.length = 0
  let frame = state.frame
  if (frame === undefined || frame.width !== picture.width || frame.height !== picture.height) {
    frame = new Canvas(picture.width, picture.height)
    if (cache !== undefined) state.frame = frame
  }

  const resting = (n: SceneNode): boolean => n.isRestingBreath === true && !scene.isAnyRunning
  const sampler = (n: SceneNode): Sampled => (resting(n) ? firstValues(n) : sample(n, scene.now, t))
  const live = (n: SceneNode): Sampled => (hasOwnAnimations(n) ? sample(n, scene.now, t) : NOTHING)

  const parts: (Run | Direct)[] = []
  let run: Run | undefined
  for (const n of scene.nodes) {
    if (!resting(n) && isChanging(n, scene.now, t)) {
      parts.push({ kind: 'direct', node: n })
      run = undefined
      continue
    }
    const group = n.group ?? ''
    if (run !== undefined && run.group === group) run.nodes.push(n)
    else {
      run = { kind: 'layer', group, nodes: [n], samples: new Map(), key: '' }
      parts.push(run)
    }
  }

  const paint = painter(state.pairs)
  const base = scale(picture.scale)
  const used = new Set<string>()
  const layerOf = (r: Run): Layer => {
    r.key = keyOf(r, sampler)
    used.add(r.key)
    let layer = state.layers.get(r.key)
    if (layer === undefined) {
      layer = build(r, base, picture, paint)
      state.layers.set(r.key, layer)
      state.repainted.push(r.key)
    }
    return layer
  }

  // The first layer goes onto a clear frame, where source-over is a copy.
  let k = 0
  const first = parts[0]
  if (first !== undefined && first.kind === 'layer') {
    const layer = layerOf(first)
    if (layer.x === 0 && layer.y === 0 && layer.canvas.width === frame.width && layer.canvas.height === frame.height) frame.data.set(layer.canvas.data)
    else {
      frame.clear()
      copyRows(frame, layer)
    }
    k = 1
  } else frame.clear()

  for (; k < parts.length; k++) {
    const part = parts[k]!
    if (part.kind === 'layer') composite(frame, layerOf(part))
    else {
      const ops: Op[] = []
      opsOf(part.node, base, 1, live, paint, ops)
      for (const op of ops) perform(op, frame, 0, 0)
    }
  }

  for (const key of state.layers.keys()) if (!used.has(key)) state.layers.delete(key)
  return frame
}

// ---- keys -------------------------------------------------------------------------------------

const ANIMATIONS = new Set(['animate', 'animateMotion', 'animateTransform'])
const isAnimation = (n: SceneNode | string): n is SceneNode => typeof n !== 'string' && ANIMATIONS.has(n.tag)
const NOTHING: Sampled = { values: new Map() }

const ownAnimations = new WeakMap<SceneNode, boolean>()
function hasOwnAnimations(n: SceneNode): boolean {
  let v = ownAnimations.get(n)
  if (v === undefined) {
    v = (n.children ?? []).some(isAnimation)
    ownAnimations.set(n, v)
  }
  return v
}

const animatedBelow = new WeakMap<SceneNode, boolean>()
/** True when the node or anything under it has an animation. */
function isAnimated(n: SceneNode): boolean {
  let v = animatedBelow.get(n)
  if (v === undefined) {
    v = (n.children ?? []).some(c => typeof c !== 'string' && (ANIMATIONS.has(c.tag) || isAnimated(c)))
    animatedBelow.set(n, v)
  }
  return v
}

const signatures = new WeakMap<SceneNode, string>()
/** The node's tag, attributes and drawn children, its animations left out: what it is, whenever it is drawn. */
function signatureOf(n: SceneNode): string {
  let s = signatures.get(n)
  if (s !== undefined) return s
  s = `<${n.tag}`
  for (const [k, v] of n.attrs) s += ` ${k}="${v}"`
  s += '>'
  for (const c of n.children ?? []) {
    if (typeof c === 'string') s += JSON.stringify(c)
    else if (!ANIMATIONS.has(c.tag)) s += signatureOf(c)
  }
  s += `</${n.tag}>`
  signatures.set(n, s)
  return s
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000

function rounded(s: Sampled): Sampled {
  const values = new Map<string, number>()
  for (const [k, v] of s.values) values.set(k, r3(v))
  const out: Sampled = { values }
  if (s.offset) out.offset = { x: r3(s.offset.x), y: r3(s.offset.y) }
  if (s.rotate) out.rotate = { degrees: r3(s.rotate.degrees), cx: r3(s.rotate.cx), cy: r3(s.rotate.cy) }
  return out
}

function written(s: Sampled): string {
  let out = ''
  for (const [k, v] of s.values) out += `${k}=${v};`
  if (s.offset) out += `@${s.offset.x},${s.offset.y};`
  if (s.rotate) out += `rotate ${s.rotate.degrees},${s.rotate.cx},${s.rotate.cy};`
  return out
}

/** The values a node and the nodes under it take at t, rounded, kept in `into` for painting and written out for the key. */
function sampledKey(n: SceneNode, sampler: (n: SceneNode) => Sampled, into: Map<SceneNode, Sampled>): string {
  let s = ''
  if (hasOwnAnimations(n)) {
    const v = rounded(sampler(n))
    into.set(n, v)
    s += written(v)
  }
  for (const c of n.children ?? []) if (typeof c !== 'string' && !ANIMATIONS.has(c.tag) && isAnimated(c)) s += `{${sampledKey(c, sampler, into)}}`
  return s
}

/**
 * A run's key: its group, then each node as it is written without its animations, then the values its animations
 * give at t. A scene built later, whose drawing is the same, gives the same key.
 */
function keyOf(r: Run, sampler: (n: SceneNode) => Sampled): string {
  let key = r.group
  for (const n of r.nodes) {
    key += `\n${signatureOf(n)}`
    if (isAnimated(n)) key += `\t${sampledKey(n, sampler, r.samples)}`
  }
  return key
}

/** The resting breath: each animation's first value. */
function firstValues(n: SceneNode): Sampled {
  const out: Sampled = { values: new Map() }
  for (const c of n.children ?? []) {
    if (typeof c === 'string' || c.tag !== 'animate') continue
    const name = attrOf(c, 'attributeName')
    const list = attrOf(c, 'values') ?? attrOf(c, 'from')
    if (name === undefined || list === undefined || out.values.has(name)) continue
    const v = parseFloat(list.split(';')[0]!)
    if (Number.isFinite(v)) out.values.set(name, v)
  }
  return out
}

// ---- layers -----------------------------------------------------------------------------------

const MARGIN = 2

function build(r: Run, base: Matrix, picture: Picture, paint: Paint): Layer {
  const ops: Op[] = []
  const valuesOf = (n: SceneNode): Sampled => r.samples.get(n) ?? NOTHING
  for (const n of r.nodes) opsOf(n, base, 1, valuesOf, paint, ops)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const op of ops) {
    const b = boxOf(op)
    if (!(Number.isFinite(b.x0) && Number.isFinite(b.y0) && Number.isFinite(b.x1) && Number.isFinite(b.y1))) continue
    if (b.x0 < x0) x0 = b.x0
    if (b.y0 < y0) y0 = b.y0
    if (b.x1 > x1) x1 = b.x1
    if (b.y1 > y1) y1 = b.y1
  }
  const left = Math.max(0, Math.floor(x0) - MARGIN)
  const top = Math.max(0, Math.floor(y0) - MARGIN)
  const right = Math.min(picture.width, Math.ceil(x1) + MARGIN)
  const bottom = Math.min(picture.height, Math.ceil(y1) + MARGIN)
  if (!(right > left && bottom > top)) return { canvas: new Canvas(0, 0), x: 0, y: 0, spans: new Int32Array(0) }
  const canvas = new Canvas(right - left, bottom - top)
  for (const op of ops) perform(op, canvas, -left, -top)
  return { canvas, x: left, y: top, spans: spansOf(canvas) }
}

/** Each row's inked columns as [from, to). A clear pixel is a zero word: premultiplied colour never exceeds alpha. */
function spansOf(c: Canvas): Int32Array {
  const spans = new Int32Array(c.height * 2)
  const words = new Uint32Array(c.data.buffer, c.data.byteOffset, c.data.length >> 2)
  for (let y = 0; y < c.height; y++) {
    const row = y * c.width
    let a = 0
    while (a < c.width && words[row + a] === 0) a++
    if (a === c.width) continue
    let b = c.width
    while (words[row + b - 1] === 0) b--
    spans[2 * y] = a
    spans[2 * y + 1] = b
  }
  return spans
}

/** The layer onto a frame that is clear where it lies: a copy, row by row. */
function copyRows(dst: Canvas, layer: Layer): void {
  const src = layer.canvas
  const rowBytes = src.width * 4
  for (let y = 0; y < src.height; y++) {
    dst.data.set(src.data.subarray(y * rowBytes, (y + 1) * rowBytes), ((layer.y + y) * dst.width + layer.x) * 4)
  }
}

/** Premultiplied source-over of a layer at its place, over its inked spans only. */
function composite(dst: Canvas, layer: Layer): void {
  const src = layer.canvas
  const s = src.data
  const d = dst.data
  const spans = layer.spans
  for (let y = 0; y < src.height; y++) {
    const a = spans[2 * y]!
    const b = spans[2 * y + 1]!
    if (a >= b) continue
    let si = (y * src.width + a) * 4
    let di = ((layer.y + y) * dst.width + layer.x + a) * 4
    for (let x = a; x < b; x++, si += 4, di += 4) {
      const sa = s[si + 3]!
      if (sa === 0) continue
      if (sa === 255) {
        d[di] = s[si]!
        d[di + 1] = s[si + 1]!
        d[di + 2] = s[si + 2]!
        d[di + 3] = 255
        continue
      }
      const inv = 255 - sa
      d[di] = Math.min(255, s[si]! + (((d[di]! * inv + 127) / 255) | 0))
      d[di + 1] = Math.min(255, s[si + 1]! + (((d[di + 1]! * inv + 127) / 255) | 0))
      d[di + 2] = Math.min(255, s[si + 2]! + (((d[di + 2]! * inv + 127) / 255) | 0))
      d[di + 3] = Math.min(255, sa + (((d[di + 3]! * inv + 127) / 255) | 0))
    }
  }
}

// ---- nodes as drawing operations --------------------------------------------------------------

type Box = { x0: number; y0: number; x1: number; y1: number }

/** One call of the rasteriser, in picture pixels. */
type Op =
  | { kind: 'fill'; lines: Polyline[]; color: Rgb; alpha: number }
  | { kind: 'stroke'; lines: Polyline[]; width: number; color: Rgb; alpha: number; cap: 'butt' | 'round' }
  | { kind: 'text'; spec: TextSpec; box: Box }

function pointsBox(lines: Polyline[], pad: number): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const l of lines) {
    for (const p of l.points) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad }
}

/** Where an operation can leave ink: a stroke reaches half its width and a pixel of anti-aliasing past its line. */
function boxOf(op: Op): Box {
  if (op.kind === 'text') return op.box
  return pointsBox(op.lines, op.kind === 'stroke' ? op.width / 2 + 1 : 0)
}

const moved = (lines: Polyline[], dx: number, dy: number): Polyline[] =>
  dx === 0 && dy === 0 ? lines : lines.map(l => ({ closed: l.closed, points: l.points.map(p => ({ x: p.x + dx, y: p.y + dy })) }))

function perform(op: Op, c: Canvas, dx: number, dy: number): void {
  if (op.kind === 'fill') fill(c, moved(op.lines, dx, dy), op.color, op.alpha)
  else if (op.kind === 'stroke') stroke(c, moved(op.lines, dx, dy), op.width, op.color, op.alpha, op.cap)
  else drawText(c, FONT, dx === 0 && dy === 0 ? op.spec : { ...op.spec, x: op.spec.x + dx, y: op.spec.y + dy })
}

/** Colours as the frame paints them: `none` is no paint; on a light terminal the dark palette becomes the light one. */
type Paint = { colorOf: (value: string | undefined) => Rgb | undefined }

const rgbs = new Map<string, Rgb>()
function rgbOf(hex: string): Rgb {
  let c = rgbs.get(hex)
  if (c === undefined) {
    if (rgbs.size > 256) rgbs.clear()
    c = parseColor(hex)
    rgbs.set(hex, c)
  }
  return c
}

function painter(pairs: Map<string, string> | undefined): Paint {
  return {
    colorOf: value => {
      if (value === undefined || value === 'none' || value === 'transparent') return undefined
      return rgbOf(pairs?.get(value) ?? value)
    },
  }
}

const attrMaps = new WeakMap<SceneNode, Map<string, string>>()
function attrsOf(n: SceneNode): Map<string, string> {
  let m = attrMaps.get(n)
  if (m === undefined) {
    m = new Map(n.attrs)
    attrMaps.set(n, m)
  }
  return m
}
const attrOf = (n: SceneNode, name: string): string | undefined => attrsOf(n).get(name)

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const transforms = new Map<string, Matrix>()
/** `translate`, `rotate`, `scale` and `matrix`, in order; anything else is left out. */
function transformOf(text: string): Matrix {
  let m = transforms.get(text)
  if (m !== undefined) return m
  m = IDENTITY
  for (const [, name, args] of text.matchAll(/(matrix|translate|scale|rotate)\s*\(([^)]*)\)/g)) {
    const v = (args!.match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g) ?? []).map(Number)
    if (name === 'translate') m = multiply(m, translate(v[0] ?? 0, v[1] ?? 0))
    else if (name === 'rotate') m = multiply(m, rotateAbout(v[0] ?? 0, v[1] ?? 0, v[2] ?? 0))
    else if (name === 'scale') m = multiply(m, [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0])
    else if (v.length === 6) m = multiply(m, v as unknown as Matrix)
  }
  if (transforms.size > 256) transforms.clear()
  transforms.set(text, m)
  return m
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * A node as drawing operations under matrix `m`, at `alpha`. Sampled values override the node's attributes; a
 * sampled offset moves it and a sampled rotation turns it and what it holds. Unknown tags draw nothing.
 */
function opsOf(n: SceneNode, m: Matrix, alpha: number, valuesOf: (n: SceneNode) => Sampled, paint: Paint, out: Op[]): void {
  if (ANIMATIONS.has(n.tag)) return
  const s = valuesOf(n)
  const a = attrsOf(n)
  const num = (name: string, fallback: number): number => {
    const v = s.values.get(name)
    if (v !== undefined) return v
    const text = a.get(name)
    if (text === undefined) return fallback
    const x = parseFloat(text)
    return Number.isFinite(x) ? x : fallback
  }
  let mm = m
  if (s.offset) mm = multiply(mm, translate(s.offset.x, s.offset.y))
  // An animated rotation replaces the transform attribute, as SVG's animateTransform does.
  if (s.rotate) mm = multiply(mm, rotateAbout(s.rotate.degrees, s.rotate.cx, s.rotate.cy))
  else {
    const tr = a.get('transform')
    if (tr !== undefined) mm = multiply(mm, transformOf(tr))
  }
  const opacity = alpha * clamp01(num('opacity', 1))
  if (!(opacity > 0)) return
  const k = Math.sqrt(Math.abs(mm[0] * mm[3] - mm[1] * mm[2]))

  let shape: Polyline[]
  switch (n.tag) {
    case 'g':
      for (const c of n.children ?? []) if (typeof c !== 'string') opsOf(c, mm, opacity, valuesOf, paint, out)
      return
    case 'text':
      textOps(n, a, num, mm, k, opacity, paint, out)
      return
    case 'rect': {
      const w = num('width', 0)
      const h = num('height', 0)
      if (!(w > 0 && h > 0)) return
      shape = roundRect(num('x', 0), num('y', 0), w, h, a.has('rx') ? num('rx', 0) : num('ry', 0), mm)
      break
    }
    case 'circle': {
      const r = num('r', 0)
      if (!(r > 0)) return
      shape = circle(num('cx', 0), num('cy', 0), r, mm)
      break
    }
    case 'ellipse': {
      const rx = num('rx', 0)
      const ry = num('ry', 0)
      if (!(rx > 0 && ry > 0)) return
      shape = ellipse(num('cx', 0), num('cy', 0), rx, ry, mm)
      break
    }
    case 'line':
      shape = line(num('x1', 0), num('y1', 0), num('x2', 0), num('y2', 0), mm)
      break
    case 'path': {
      const d = a.get('d')
      if (d === undefined) return
      try {
        shape = parsePath(d, mm)
      } catch {
        return
      }
      break
    }
    default:
      return
  }

  if (n.tag !== 'line') {
    // SVG fills a shape black unless told otherwise.
    const color = paint.colorOf(a.get('fill') ?? '#000000')
    if (color !== undefined) out.push({ kind: 'fill', lines: shape, color, alpha: opacity * clamp01(num('fill-opacity', 1)) })
  }
  const color = paint.colorOf(a.get('stroke'))
  const width = num('stroke-width', 1) * k
  if (color !== undefined && width > 0) {
    out.push({
      kind: 'stroke',
      lines: dashesOf(shape, a.get('stroke-dasharray'), num('stroke-dashoffset', 0), num('pathLength', 0), k),
      width,
      color,
      alpha: opacity * clamp01(num('stroke-opacity', 1)),
      cap: a.get('stroke-linecap') === 'round' ? 'round' : 'butt',
    })
  }
}

/** Dash lengths are in the scene's units, or in `pathLength`'s when the element has one. */
function dashesOf(shape: Polyline[], list: string | undefined, offset: number, pathLength: number, k: number): Polyline[] {
  if (list === undefined || list === 'none') return shape
  const pattern = list.split(/[\s,]+/).filter(v => v !== '').map(Number)
  if (pattern.length === 0 || pattern.some(v => !Number.isFinite(v) || v < 0)) return shape
  return pathLength > 0 ? dashed(shape, pattern, offset, pathLength) : dashed(shape, pattern.map(v => v * k), offset * k)
}

const ENTITIES = new Map([['lt', '<'], ['gt', '>'], ['amp', '&'], ['quot', '"'], ['apos', "'"]])
/** The scene's text is written for XML; the picture shows it as read. */
function unescapeXml(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#[0-9]+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, e: string) => {
    if (e[0] !== '#') return ENTITIES.get(e) ?? whole
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  })
}

const isBold = (w: string | undefined): boolean => w === 'bold' || w === 'bolder' || Number(w) >= 600

/** A text and its tspans as runs of their own colours, sized × TEXT_SCALE, on a rim when the stroke is painted first. */
function textOps(
  n: SceneNode,
  a: Map<string, string>,
  num: (name: string, fallback: number) => number,
  mm: Matrix,
  k: number,
  opacity: number,
  paint: Paint,
  out: Op[],
): void {
  const own = paint.colorOf(a.get('fill') ?? '#000000')
  const runs: TextRun[] = []
  for (const c of n.children ?? []) {
    if (typeof c === 'string') {
      if (own !== undefined && c !== '') runs.push({ text: unescapeXml(c), color: own })
    } else if (c.tag === 'tspan') {
      const fillOf = attrOf(c, 'fill')
      const color = fillOf === undefined ? own : paint.colorOf(fillOf)
      if (color === undefined) continue
      for (const t of c.children ?? []) if (typeof t === 'string' && t !== '') runs.push({ text: unescapeXml(t), color })
    }
  }
  if (runs.length === 0) return
  const size = num('font-size', 16) * TEXT_SCALE * k
  if (!(size > 0)) return
  const bold = isBold(a.get('font-weight'))
  const face = bold ? FONT.bold : FONT.regular
  const letterSpacing = num('letter-spacing', 0) * TEXT_SCALE * k
  const px = num('x', 0)
  const py = num('y', 0)
  let x = mm[0] * px + mm[2] * py + mm[4]
  const y = mm[1] * px + mm[3] * py + mm[5]
  const anchorOf = a.get('text-anchor')
  if (anchorOf === 'end') {
    let count = 0
    for (const r of runs) count += [...r.text].length
    x -= count * ((face.advance * size) / face.unitsPerEm + letterSpacing)
  }
  const rimColor = a.get('paint-order')?.startsWith('stroke') ? paint.colorOf(a.get('stroke')) : undefined
  const rimWidth = num('stroke-width', 1) * k
  const spec: TextSpec = { runs, x, y, size, anchor: anchorOf === 'middle' ? 'middle' : 'start', letterSpacing, bold, alpha: opacity }
  if (rimColor !== undefined && rimWidth > 0) spec.rim = { color: rimColor, width: rimWidth }
  out.push({ kind: 'text', spec, box: textBox(face, spec) })
}

/** Each glyph's ink in font units, y up, as [x0, y0, x1, y1]; null for a blank. A missing glyph is a box in its advance. */
const glyphBoxes = new WeakMap<FontFace, Map<string, readonly number[] | null>>()
function glyphBox(face: FontFace, ch: string): readonly number[] | null {
  let boxes = glyphBoxes.get(face)
  if (boxes === undefined) glyphBoxes.set(face, (boxes = new Map()))
  let b = boxes.get(ch)
  if (b !== undefined) return b
  if (!Object.prototype.hasOwnProperty.call(face.glyphs, ch)) b = [0, 0, face.advance, face.capHeight]
  else {
    let lines: Polyline[] = []
    try {
      lines = parsePath(face.glyphs[ch]!)
    } catch {}
    const box = pointsBox(lines, 0)
    b = Number.isFinite(box.x0) ? [box.x0, box.y0, box.x1, box.y1] : null
  }
  boxes.set(ch, b)
  return b
}

/** Where a text can leave ink: its glyphs where drawText sets them, its rim and a pixel of anti-aliasing. */
function textBox(face: FontFace, spec: TextSpec): Box {
  const k = spec.size / face.unitsPerEm
  const pitch = face.advance * k + (spec.letterSpacing ?? 0)
  let count = 0
  for (const r of spec.runs) count += [...r.text].length
  let x = spec.anchor === 'middle' ? spec.x - (count * pitch) / 2 : spec.x
  const box: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const r of spec.runs) {
    for (const ch of r.text) {
      const g = glyphBox(face, ch)
      if (g !== null) {
        box.x0 = Math.min(box.x0, x + g[0]! * k)
        box.x1 = Math.max(box.x1, x + g[2]! * k)
        box.y0 = Math.min(box.y0, spec.y - g[3]! * k)
        box.y1 = Math.max(box.y1, spec.y - g[1]! * k)
      }
      x += pitch
    }
  }
  const pad = (spec.rim ? spec.rim.width / 2 : 0) + (face.kind === 'stroke' ? (face.strokeWidth * k) / 2 : 0) + 1
  return { x0: box.x0 - pad, y0: box.y0 - pad, x1: box.x1 + pad, y1: box.y1 + pad }
}

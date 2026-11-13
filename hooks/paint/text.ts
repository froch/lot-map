// Text on the pixel canvas: monospaced runs, anchored at the start or the middle, on an optional rim.
// Nothing here touches the engine.
import type { Canvas, Rgb } from './canvas'
import type { Font, FontFace } from './font'
import { fill, parsePath, stroke, type Matrix, type Polyline } from './path'

export type TextRun = { text: string; color: Rgb }

/** In canvas pixels; `y` is the baseline. */
export type TextSpec = {
  runs: TextRun[]
  x: number
  y: number
  size: number
  anchor: 'start' | 'middle'
  letterSpacing?: number
  bold?: boolean
  alpha?: number
  rim?: { color: Rgb; width: number }
}

/** Characters, not UTF-16 units: an emoji is one character and one box. */
const count = (text: string) => [...text].length

const step = (face: FontFace, size: number, letterSpacing: number) => (face.advance * size) / face.unitsPerEm + letterSpacing

/** Letter-spacing follows every character, the last one included, as browsers do. */
export function textWidth(font: Font, text: string, size: number, letterSpacing = 0): number {
  return count(text) * step(font.regular, size, letterSpacing)
}

// A character the font lacks is a hollow box capHeight tall, filling its advance but for half a line at each side,
// so that two boxes stand apart. An outline face draws its line 0.07 em thick, a stroke face at its strokeWidth.
const BOX_LINE = 0.07
const boxes = new WeakMap<FontFace, string>()
function box(face: FontFace): string {
  let d = boxes.get(face)
  if (d !== undefined) return d
  const w = face.advance
  const h = face.capHeight
  if (face.kind === 'stroke') {
    const t = face.strokeWidth
    d = `M${t} ${t / 2}H${w - t}V${h - t / 2}H${t}Z`
  } else {
    const t = face.unitsPerEm * BOX_LINE
    const l = t / 2
    const r = w - t / 2
    // the inner square runs the other way round, so it cuts a hole
    d = `M${l} 0H${r}V${h}H${l}Z M${l + t} ${t}V${h - t}H${r - t}V${t}Z`
  }
  boxes.set(face, d)
  return d
}

const has = (face: FontFace, ch: string) => Object.prototype.hasOwnProperty.call(face.glyphs, ch)

export function drawText(c: Canvas, font: Font, spec: TextSpec): void {
  const face = spec.bold ? font.bold : font.regular
  const alpha = spec.alpha ?? 1
  const k = spec.size / face.unitsPerEm
  const pitch = step(face, spec.size, spec.letterSpacing ?? 0)
  let n = 0
  for (const r of spec.runs) n += count(r.text)
  let x = spec.anchor === 'middle' ? spec.x - (n * pitch) / 2 : spec.x
  const glyphs: { shape: Polyline[]; color: Rgb }[] = []
  for (const r of spec.runs) {
    for (const ch of r.text) {
      const m: Matrix = [k, 0, 0, -k, x, spec.y]
      const d = has(face, ch) ? face.glyphs[ch]! : box(face)
      if (d) glyphs.push({ shape: parsePath(d, m), color: r.color })
      x += pitch
    }
  }
  const pen = face.strokeWidth * k
  if (spec.rim) {
    // the rim strokes the letters' outline; a stroke face's outline lies half its pen out from the path
    const width = spec.rim.width + (face.kind === 'stroke' ? pen : 0)
    for (const g of glyphs) stroke(c, g.shape, width, spec.rim.color, alpha, 'round')
  }
  for (const g of glyphs) {
    if (face.kind === 'stroke') stroke(c, g.shape, pen, g.color, alpha, 'round')
    else fill(c, g.shape, g.color, alpha)
  }
}

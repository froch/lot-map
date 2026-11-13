// Writes the outline font candidate: JetBrains Mono's outlines for every COVERAGE character, regular and bold.
//   bun scripts/font/build-outline.ts <JetBrainsMono-Regular.ttf> <JetBrainsMono-Bold.ttf> > hooks/paint/font-outline.ts
// Development only. The fonts are read as data and nothing in them runs. Same input, same bytes out.
import { readFileSync } from 'node:fs'
import { COVERAGE } from '../../hooks/paint/font'
import { readTtf, type Contour, type Point, type Ttf } from './ttf'

// Letters the font has no glyph for, made the way it makes their Latin twins: the base, and the grave of a
// Latin letter moved to sit over the base as it sits over that letter.
const COMPOSED: Readonly<Record<string, { base: string; accentOf: string; over: string }>> = {
  'Ѐ': { base: 'Е', accentOf: 'È', over: 'E' },
  'Ѝ': { base: 'И', accentOf: 'È', over: 'E' },
  'ѐ': { base: 'е', accentOf: 'è', over: 'e' },
  'ѝ': { base: 'и', accentOf: 'è', over: 'e' },
}

const glyphOf = (ttf: Ttf, ch: string) => {
  const g = ttf.glyphIndex(ch.codePointAt(0)!)
  if (g === 0 && ch !== ' ') throw new Error(`the font has no glyph for ${JSON.stringify(ch)}`)
  return g
}

const middle = (contours: Contour[]) => {
  const xs = contours.flat().map(p => p.x)
  return (Math.min(...xs) + Math.max(...xs)) / 2
}

function contoursOf(ttf: Ttf, ch: string): Contour[] {
  const made = COMPOSED[ch]
  if (!made) return ttf.contours(glyphOf(ttf, ch))
  const over = glyphOf(ttf, made.over)
  const accents = ttf.parts(glyphOf(ttf, made.accentOf)).filter(p => p.glyph !== over)
  if (accents.length !== 1) throw new Error(`expected one accent in ${made.accentOf}`)
  const accent = accents[0]!
  const base = ttf.contours(glyphOf(ttf, made.base))
  const shift = middle(base) - middle(ttf.contours(over))
  const marks = ttf.contours(accent.glyph).map(c =>
    c.map(q => ({ x: accent.a * q.x + accent.c * q.y + accent.dx + shift, y: accent.b * q.x + accent.d * q.y + accent.dy, on: q.on })),
  )
  return [...base, ...marks]
}

/** SVG path data, relative commands, every coordinate rounded to a whole font unit. */
function pathOf(contours: Contour[]): string {
  let out = ''
  let cx = 0
  let cy = 0
  let last = ''
  const put = (letter: string, ...values: number[]) => {
    if (letter !== last || letter === 'm' || letter === 'z') out += letter
    else if (values.length > 0 && values[0]! >= 0) out += ' '
    last = letter
    values.forEach((v, i) => {
      if (i > 0 && v >= 0) out += ' '
      out += String(v)
    })
  }
  const to = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) })
  const line = (p: { x: number; y: number }) => {
    const q = to(p)
    const dx = q.x - cx
    const dy = q.y - cy
    if (dx === 0 && dy === 0) return
    if (dy === 0) put('h', dx)
    else if (dx === 0) put('v', dy)
    else put('l', dx, dy)
    cx = q.x
    cy = q.y
  }
  const curve = (c: { x: number; y: number }, p: { x: number; y: number }) => {
    const k = to(c)
    const q = to(p)
    put('q', k.x - cx, k.y - cy, q.x - cx, q.y - cy)
    cx = q.x
    cy = q.y
  }
  for (const contour of contours) {
    if (contour.length < 3) continue
    const at = contour.findIndex(p => p.on)
    const pts: Point[] =
      at < 0
        ? [{ x: (contour[contour.length - 1]!.x + contour[0]!.x) / 2, y: (contour[contour.length - 1]!.y + contour[0]!.y) / 2, on: true }, ...contour]
        : [...contour.slice(at), ...contour.slice(0, at)]
    const start = to(pts[0]!)
    // after z the pen is back at the start of the closed contour, which is where the next m counts from
    put('m', start.x - cx, start.y - cy)
    cx = start.x
    cy = start.y
    let control: Point | null = null
    for (let i = 1; i <= pts.length; i++) {
      const p = i === pts.length ? pts[0]! : pts[i]!
      if (p.on) {
        if (control) curve(control, p)
        else if (i < pts.length) line(p)
        control = null
      } else {
        if (control) curve(control, { x: (control.x + p.x) / 2, y: (control.y + p.y) / 2 })
        control = p
      }
    }
    put('z')
    cx = start.x
    cy = start.y
  }
  return out
}

function face(ttf: Ttf, name: string): string {
  const advance = ttf.advance(glyphOf(ttf, 'H'))
  const lines: string[] = []
  for (const ch of COVERAGE) {
    const made = COMPOSED[ch]
    const width = ttf.advance(glyphOf(ttf, made ? made.base : ch))
    if (width !== advance) throw new Error(`${name}: ${JSON.stringify(ch)} is ${width} wide, not ${advance}`)
    lines.push(`      ${JSON.stringify(ch)}: ${JSON.stringify(pathOf(contoursOf(ttf, ch)))},`)
  }
  return [
    `  ${name}: {`,
    `    kind: 'outline',`,
    `    unitsPerEm: ${ttf.unitsPerEm},`,
    `    ascent: ${ttf.ascent},`,
    `    capHeight: ${ttf.capHeight},`,
    `    advance: ${advance},`,
    `    strokeWidth: 0,`,
    `    glyphs: {`,
    ...lines,
    `    },`,
    `  },`,
  ].join('\n')
}

if (import.meta.main) {
  const [regularPath, boldPath] = process.argv.slice(2)
  if (!regularPath || !boldPath) throw new Error('usage: bun scripts/font/build-outline.ts <Regular.ttf> <Bold.ttf>')
  const regular = readTtf(new Uint8Array(readFileSync(regularPath)))
  const bold = readTtf(new Uint8Array(readFileSync(boldPath)))
  if (regular.unitsPerEm !== bold.unitsPerEm) throw new Error('the two weights differ in units per em')
  if (regular.advance(glyphOf(regular, 'H')) !== bold.advance(glyphOf(bold, 'H'))) throw new Error('the two weights differ in advance')
  const out = [
    '// JetBrains Mono, Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono), under the SIL Open Font License 1.1 in OFL.txt beside this file.',
    '// Generated by scripts/font/build-outline.ts from JetBrainsMono-Regular.ttf and JetBrainsMono-Bold.ttf. Do not edit.',
    "import type { Font } from './font'",
    '',
    'export const OUTLINE: Font = {',
    face(regular, 'regular'),
    face(bold, 'bold'),
    '}',
    '',
  ].join('\n')
  process.stdout.write(out)
}

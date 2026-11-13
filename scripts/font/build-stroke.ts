// Writes the stroke font candidate: Hershey Roman Simplex for printable ASCII, and the rest of what the font
// checkpoint's still draws (Cyrillic, ä ö ü ß and a few signs) drawn here by hand in the same measures.
//   bun scripts/font/build-stroke.ts <rowmans.jhf> > hooks/paint/font-stroke.ts
// Development only. The .jhf file is read as data. Same input, same bytes out.
import { readFileSync } from 'node:fs'
import { STILL_TEXT } from '../../hooks/paint/font'

/** Polylines in font units, y up from the baseline, as flat lists x0 y0 x1 y1 … */
type Strokes = number[][]

// Roman Simplex's grid is the font's unit: capitals stand 21 high, small letters 14, descenders reach 7 below,
// and its brackets span the em, from 25 above the baseline to 7 below: 32 units.
const UNITS_PER_EM = 32
const ASCENT = 25
const CAP_HEIGHT = 21
// About the stem of the outline candidate (0.09 em): lighter reads faint at 13 px, heavier fills the e at 13 px.
const STROKE_WIDTH = 2.8
const BOLD = 1.6

/** Reads a .jhf file: one glyph a record, printable ASCII from the space on, in Hershey's y-down grid. */
function readJhf(text: string): Map<string, { strokes: Strokes; width: number }> {
  const lines = text.split(/\r?\n/)
  const glyphs = new Map<string, { strokes: Strokes; width: number }>()
  let i = 0
  for (let code = 0x20; code <= 0x7e; code++) {
    let record = lines[i++] ?? ''
    const pairs = Number(record.slice(5, 8))
    if (!Number.isInteger(pairs) || pairs < 1) throw new Error(`bad record for ${JSON.stringify(String.fromCharCode(code))}`)
    // a long record may run on over the next lines
    while (record.length < 8 + 2 * pairs && i < lines.length) record += lines[i++]
    // the first pair is the glyph's left and right sides
    const width = record.charCodeAt(9) - record.charCodeAt(8)
    const body = record.slice(10, 8 + 2 * pairs)
    const strokes: Strokes = [[]]
    for (let j = 0; j + 1 < body.length; j += 2) {
      if (body[j] === ' ' && body[j + 1] === 'R') { strokes.push([]); continue }
      // x and y count from R; the baseline is at 9 and y grows downward
      strokes[strokes.length - 1]!.push(body.charCodeAt(j) - 82, 9 - (body.charCodeAt(j + 1) - 82))
    }
    glyphs.set(String.fromCharCode(code), { strokes: strokes.filter(s => s.length >= 4), width })
  }
  return glyphs
}

// Cyrillic letters that are Latin ones under another code point.
const SAME: Readonly<Record<string, string>> = {
  'А': 'A', 'М': 'M', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'у': 'y',
}

// Drawn by hand on Roman Simplex's grid and in its manner: single strokes, caps 21 high, x-height 14, the
// small letters about as wide as its n (11) and o (13), curves stepped as its own are.
const DRAWN: Readonly<Record<string, Strokes>> = {
  'Б': [[6, 21, -7, 21, -7, 0, 2, 0, 5, 1, 6, 2, 7, 4, 7, 7, 6, 9, 5, 10, 2, 11, -7, 11]],
  'П': [[-7, 0, -7, 21, 7, 21, 7, 0]],
  'Ф': [[0, 21, 0, 0], [-2, 17, -5, 16, -7, 14, -8, 12, -8, 9, -7, 7, -5, 5, -2, 4, 2, 4, 5, 5, 7, 7, 8, 9, 8, 12, 7, 14, 5, 16, 2, 17, -2, 17]],
  'г': [[-4, 0, -4, 14, 5, 14]],
  'д': [[-7, -4, -7, 0, 7, 0, 7, -4], [5, 0, 5, 14, -2, 14, -2, 9, -3, 4, -4, 1, -5, 0]],
  'з': [[-5, 11, -4, 13, -1, 14, 2, 14, 4, 13, 5, 11, 4, 9, 2, 8, -1, 8], [2, 8, 4, 7, 5, 6, 6, 4, 6, 3, 5, 1, 2, 0, -1, 0, -4, 1, -5, 3]],
  'и': [[-5, 14, -5, 0, 6, 14, 6, 0]],
  'к': [[-5, 14, -5, 0], [5, 14, -5, 4], [-1, 8, 6, 0]],
  'л': [[6, 0, 6, 14, -2, 14, -2, 9, -3, 4, -4, 1, -5, 0, -6, 0]],
  'м': [[-6, 0, -6, 14, 0, 0, 6, 14, 6, 0]],
  'н': [[-5, 14, -5, 0], [6, 14, 6, 0], [-5, 7, 6, 7]],
  'т': [[-6, 14, 6, 14], [0, 14, 0, 0]],
  'ы': [[-8, 14, -8, 0, -2, 0, 0, 1, 1, 2, 2, 4, 1, 6, 0, 7, -2, 8, -8, 8], [7, 14, 7, 0]],
  'ь': [[-5, 14, -5, 0, 2, 0, 4, 1, 5, 2, 6, 4, 5, 6, 4, 7, 2, 8, -5, 8]],
  'я': [[5, 0, 5, 14, -1, 14, -3, 13, -4, 12, -5, 10, -4, 8, -3, 7, -1, 6, 5, 6], [0, 6, -6, 0]],
  'ß': [[-6, 0, -6, 15, -5, 18, -4, 20, -2, 21, 1, 21, 3, 20, 4, 18, 4, 16, 3, 14, 0, 13], [0, 13, 3, 12, 5, 11, 6, 9, 6, 4, 5, 2, 3, 0, 0, 0]],
  '·': [[0, 9, -1, 8, 0, 7, 1, 8, 0, 9]],
  '×': [[-5, 4, 5, 14], [-5, 14, 5, 4]],
  '↓': [[0, 21, 0, 0], [-5, 6, 0, 0, 5, 6]],
}

// Marks over a small letter, centred on x = 0 and moved over the letter's middle.
const DIAERESIS: Strokes = [[-4.5, 20, -3.5, 21, -2.5, 20, -3.5, 19, -4.5, 20], [2.5, 20, 3.5, 21, 4.5, 20, 3.5, 19, 2.5, 20]]
const BREVE: Strokes = [[-3, 20, -2, 18, 0, 17, 2, 18, 3, 20]]
const MARKED: Readonly<Record<string, { base: string; mark: Strokes }>> = {
  'ä': { base: 'a', mark: DIAERESIS },
  'ö': { base: 'o', mark: DIAERESIS },
  'ü': { base: 'u', mark: DIAERESIS },
  'й': { base: 'и', mark: BREVE },
}

const middle = (strokes: Strokes) => {
  const xs = strokes.flatMap(s => s.filter((_, i) => i % 2 === 0))
  return xs.length === 0 ? 0 : (Math.min(...xs) + Math.max(...xs)) / 2
}
const shifted = (strokes: Strokes, dx: number) => strokes.map(s => s.map((v, i) => (i % 2 === 0 ? v + dx : v)))

function strokesOf(hershey: Map<string, { strokes: Strokes }>, ch: string): Strokes {
  const own = hershey.get(ch)?.strokes ?? DRAWN[ch]
  if (own) return own
  if (SAME[ch]) return strokesOf(hershey, SAME[ch])
  const marked = MARKED[ch]
  if (marked) {
    const base = strokesOf(hershey, marked.base)
    return [...base, ...shifted(marked.mark, middle(base))]
  }
  throw new Error(`no strokes for ${JSON.stringify(ch)}`)
}

const num = (v: number) => String(Math.round(v * 100) / 100)

/** SVG path data: each polyline an m and relative lines, the glyph's ink centred in the advance. */
function pathOf(strokes: Strokes, advance: number): string {
  const dx = advance / 2 - middle(strokes)
  let out = ''
  let cx = 0
  let cy = 0
  for (const s of shifted(strokes, dx)) {
    const parts: string[] = []
    for (let i = 0; i < s.length; i += 2) {
      const x = s[i]!
      const y = s[i + 1]!
      const ddx = x - cx
      const ddy = y - cy
      if (i === 0) parts.push(`m${num(ddx)} ${num(ddy)}`)
      else if (ddx === 0 && ddy === 0) continue
      else if (ddy === 0) parts.push(`h${num(ddx)}`)
      else if (ddx === 0) parts.push(`v${num(ddy)}`)
      else parts.push(`l${num(ddx)} ${num(ddy)}`)
      cx = x
      cy = y
    }
    out += parts.join('')
  }
  return out
}

function face(hershey: Map<string, { strokes: Strokes; width: number }>, name: string, strokeWidth: number, chars: string[]): string {
  // every glyph is centred in the width of the widest Latin capital (M and W, 24 with their sides)
  const advance = Math.max(...[...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map(ch => hershey.get(ch)!.width))
  return [
    `  ${name}: {`,
    `    kind: 'stroke',`,
    `    unitsPerEm: ${UNITS_PER_EM},`,
    `    ascent: ${ASCENT},`,
    `    capHeight: ${CAP_HEIGHT},`,
    `    advance: ${advance},`,
    `    strokeWidth: ${num(strokeWidth)},`,
    `    glyphs: {`,
    ...chars.map(ch => `      ${JSON.stringify(ch)}: ${JSON.stringify(pathOf(strokesOf(hershey, ch), advance))},`),
    `    },`,
    `  },`,
  ].join('\n')
}

if (import.meta.main) {
  const [jhfPath] = process.argv.slice(2)
  if (!jhfPath) throw new Error('usage: bun scripts/font/build-stroke.ts <rowmans.jhf>')
  const hershey = readJhf(readFileSync(jhfPath, 'utf8'))
  const ascii = [...hershey.keys()]
  const chars = [...new Set([...ascii, ...STILL_TEXT, ...'äöüß'])].sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
  const out = [
    '// Hershey Roman Simplex. The Hershey Fonts were originally created by Dr. A. V. Hershey while working at the U. S. National Bureau of Standards. The format of the Font data in this distribution was originally created by James Hurt, Cognition, Inc., 900 Technology Park Drive, Billerica, MA 01821 (mit-eddie!ci-dandelion!hurt).',
    '// Generated by scripts/font/build-stroke.ts from rowmans.jhf, with the Cyrillic, ä ö ü ß and signs drawn in that script. Do not edit.',
    "import type { Font } from './font'",
    '',
    'export const STROKE: Font = {',
    face(hershey, 'regular', STROKE_WIDTH, chars),
    face(hershey, 'bold', STROKE_WIDTH * BOLD, chars),
    '}',
    '',
  ].join('\n')
  process.stdout.write(out)
}

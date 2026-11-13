// What a font is to the pixel painter, and which characters it has to hold. Nothing here touches the engine.

/**
 * One weight of a monospaced font. Glyphs are SVG path data in font units, y up, the pen at the origin on the
 * baseline. An outline face fills its glyphs; a stroke face strokes them with round caps at `strokeWidth`
 * font units, which only stroke faces use.
 */
export type FontFace = {
  kind: 'outline' | 'stroke'
  unitsPerEm: number
  ascent: number
  capHeight: number
  advance: number
  strokeWidth: number
  glyphs: Readonly<Record<string, string>>
}

export type Font = { regular: FontFace; bold: FontFace }

const run = (from: number, to: number) => {
  let s = ''
  for (let c = from; c <= to; c++) s += String.fromCodePoint(c)
  return s
}

const unique = (s: string) => [...new Set(s)].join('')

/** Every character the map can draw: printable ASCII, Latin-1 letters, Cyrillic and a few signs. */
export const COVERAGE = run(0x20, 0x7e) + run(0xc0, 0xff) + run(0x400, 0x45f) + '·↓→…'

/**
 * What the font checkpoint's still draws: the station names in en, ru and de (as hooks/text.ts has them; a
 * test keeps the two in step), its figures, and the core.
 */
export const STILL_TEXT = unique(
  [
    'You Model Memory Files Shell Network Browser Agents Skills Hooks',
    'Ты Модель Память Файлы Терминал Сеть Браузер Агенты Скиллы Хуки',
    'Du Modell Gedächtnis Dateien Terminal Netzwerk Browser Agenten Skills Hooks',
    '0123456789 %+×↓·',
    'CLAUDE opus 5.5',
  ].join(' '),
)

const holds = (face: FontFace, ch: string) => Object.prototype.hasOwnProperty.call(face.glyphs, ch)

/** The characters of `text` that either weight lacks, each once, in the order they first come. */
export function missing(font: Font, text: string): string[] {
  const out: string[] = []
  for (const ch of text) if (!(holds(font.regular, ch) && holds(font.bold, ch)) && !out.includes(ch)) out.push(ch)
  return out
}

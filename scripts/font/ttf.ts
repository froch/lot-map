// A minimal TrueType reader for the font build: head, hhea, maxp, hmtx, OS/2, cmap format 4, loca and glyf.
// Development only. The font file is untrusted data: every read is bounds-checked and a bad table throws.

export type Point = { x: number; y: number; on: boolean }
/** One closed contour in font units, y up, as the file lists it. */
export type Contour = Point[]

export type Ttf = {
  unitsPerEm: number
  ascent: number
  descent: number
  capHeight: number
  /** The glyph for a code point, or 0 (.notdef) when the font has none. */
  glyphIndex(codePoint: number): number
  advance(glyph: number): number
  /** A composite glyph's components with their transforms; empty for a simple glyph. */
  parts(glyph: number): Part[]
  /** The glyph's contours, components of a composite resolved into one list. */
  contours(glyph: number): Contour[]
}

/** A component of a composite glyph: x' = a·x + c·y + dx, y' = b·x + d·y + dy. */
export type Part = { glyph: number; a: number; b: number; c: number; d: number; dx: number; dy: number }

// Composite glyph flags.
const ARGS_ARE_WORDS = 0x0001
const ARGS_ARE_XY = 0x0002
const HAS_SCALE = 0x0008
const MORE_COMPONENTS = 0x0020
const HAS_XY_SCALE = 0x0040
const HAS_2X2 = 0x0080
const SCALED_COMPONENT_OFFSET = 0x0800

export function readTtf(bytes: Uint8Array): Ttf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const need = (at: number, n: number) => {
    if (at < 0 || at + n > bytes.byteLength) throw new Error(`read past the end of the font at ${at}`)
  }
  const u8 = (at: number) => { need(at, 1); return view.getUint8(at) }
  const i8 = (at: number) => { need(at, 1); return view.getInt8(at) }
  const u16 = (at: number) => { need(at, 2); return view.getUint16(at) }
  const i16 = (at: number) => { need(at, 2); return view.getInt16(at) }
  const u32 = (at: number) => { need(at, 4); return view.getUint32(at) }
  const f2dot14 = (at: number) => i16(at) / 16384

  const tables = new Map<string, { offset: number; length: number }>()
  const numTables = u16(4)
  for (let i = 0; i < numTables; i++) {
    const at = 12 + i * 16
    const tag = String.fromCharCode(u8(at), u8(at + 1), u8(at + 2), u8(at + 3))
    const offset = u32(at + 8)
    const length = u32(at + 12)
    need(offset, length)
    tables.set(tag, { offset, length })
  }
  const table = (tag: string) => {
    const t = tables.get(tag)
    if (!t) throw new Error(`the font has no ${tag} table`)
    return t.offset
  }

  const head = table('head')
  const unitsPerEm = u16(head + 18)
  const longLoca = i16(head + 50) === 1
  const hhea = table('hhea')
  const ascent = i16(hhea + 4)
  const descent = i16(hhea + 6)
  const numberOfHMetrics = u16(hhea + 34)
  const numGlyphs = u16(table('maxp') + 4)
  const os2 = table('OS/2')
  if (u16(os2) < 2) throw new Error('OS/2 before version 2 has no sCapHeight')
  const capHeight = i16(os2 + 88)
  const hmtx = table('hmtx')
  const loca = table('loca')
  const glyf = table('glyf')

  // cmap: the Windows Unicode BMP subtable (3, 1), or Unicode BMP (0, 3), in format 4.
  const cmap = table('cmap')
  let sub = -1
  for (let i = 0; i < u16(cmap + 2); i++) {
    const at = cmap + 4 + i * 8
    const platform = u16(at)
    const encoding = u16(at + 2)
    if ((platform === 3 && encoding === 1) || (platform === 0 && encoding === 3)) {
      const candidate = cmap + u32(at + 4)
      if (u16(candidate) === 4) { sub = candidate; break }
    }
  }
  if (sub < 0) throw new Error('the font has no cmap format 4 subtable')
  const segCount = u16(sub + 6) / 2
  const endCodes = sub + 14
  const startCodes = endCodes + segCount * 2 + 2
  const idDeltas = startCodes + segCount * 2
  const idRangeOffsets = idDeltas + segCount * 2

  function glyphIndex(cp: number): number {
    if (cp > 0xffff) return 0
    for (let i = 0; i < segCount; i++) {
      if (u16(endCodes + i * 2) < cp) continue
      const start = u16(startCodes + i * 2)
      if (start > cp) return 0
      const delta = u16(idDeltas + i * 2)
      const rangeAt = idRangeOffsets + i * 2
      const range = u16(rangeAt)
      if (range === 0) return (cp + delta) & 0xffff
      const g = u16(rangeAt + range + (cp - start) * 2)
      return g === 0 ? 0 : (g + delta) & 0xffff
    }
    return 0
  }

  function advance(glyph: number): number {
    const i = Math.min(glyph, numberOfHMetrics - 1)
    return u16(hmtx + i * 4)
  }

  const location = (glyph: number) => (longLoca ? u32(loca + glyph * 4) : u16(loca + glyph * 2) * 2)

  /** A composite glyph's components, each with its transform; empty for a simple glyph. */
  function parts(glyph: number): Part[] {
    if (glyph < 0 || glyph >= numGlyphs) throw new Error(`no glyph ${glyph}`)
    const start = location(glyph)
    if (location(glyph + 1) === start) return []
    const at = glyf + start
    if (i16(at) >= 0) return []
    const out: Part[] = []
    let p = at + 10
    for (;;) {
      const flags = u16(p)
      const component = u16(p + 2)
      p += 4
      if (!(flags & ARGS_ARE_XY)) throw new Error(`glyph ${glyph} places a component by matching points, which this reader does not do`)
      let dx: number, dy: number
      if (flags & ARGS_ARE_WORDS) { dx = i16(p); dy = i16(p + 2); p += 4 }
      else { dx = i8(p); dy = i8(p + 1); p += 2 }
      let a = 1, b = 0, c = 0, d = 1
      if (flags & HAS_SCALE) { a = d = f2dot14(p); p += 2 }
      else if (flags & HAS_XY_SCALE) { a = f2dot14(p); d = f2dot14(p + 2); p += 4 }
      else if (flags & HAS_2X2) { a = f2dot14(p); b = f2dot14(p + 2); c = f2dot14(p + 4); d = f2dot14(p + 6); p += 8 }
      if (flags & SCALED_COMPONENT_OFFSET) { const ox = dx; dx = a * ox + c * dy; dy = b * ox + d * dy }
      out.push({ glyph: component, a, b, c, d, dx, dy })
      if (!(flags & MORE_COMPONENTS)) break
    }
    return out
  }

  function contours(glyph: number, depth = 0): Contour[] {
    if (depth > 8) throw new Error('composite glyphs nest too deep')
    const components = parts(glyph)
    if (components.length === 0) {
      const start = location(glyph)
      return location(glyph + 1) === start ? [] : simple(glyf + start, i16(glyf + start))
    }
    const out: Contour[] = []
    for (const { glyph: g, a, b, c, d, dx, dy } of components) {
      for (const contour of contours(g, depth + 1)) {
        out.push(contour.map(q => ({ x: a * q.x + c * q.y + dx, y: b * q.x + d * q.y + dy, on: q.on })))
      }
    }
    return out
  }

  function simple(at: number, count: number): Contour[] {
    const ends: number[] = []
    for (let i = 0; i < count; i++) ends.push(u16(at + 10 + i * 2))
    const total = count === 0 ? 0 : ends[count - 1]! + 1
    let p = at + 10 + count * 2
    p += 2 + u16(p)
    const flags: number[] = []
    while (flags.length < total) {
      const f = u8(p++)
      flags.push(f)
      if (f & 0x08) {
        const repeat = u8(p++)
        for (let r = 0; r < repeat; r++) flags.push(f)
      }
    }
    flags.length = total
    const xs: number[] = []
    let x = 0
    for (const f of flags) {
      if (f & 0x02) { const v = u8(p++); x += f & 0x10 ? v : -v }
      else if (!(f & 0x10)) { x += i16(p); p += 2 }
      xs.push(x)
    }
    const ys: number[] = []
    let y = 0
    for (const f of flags) {
      if (f & 0x04) { const v = u8(p++); y += f & 0x20 ? v : -v }
      else if (!(f & 0x20)) { y += i16(p); p += 2 }
      ys.push(y)
    }
    const out: Contour[] = []
    let first = 0
    for (const end of ends) {
      const contour: Contour = []
      for (let i = first; i <= end; i++) contour.push({ x: xs[i]!, y: ys[i]!, on: (flags[i]! & 0x01) !== 0 })
      if (contour.length > 0) out.push(contour)
      first = end + 1
    }
    return out
  }

  return { unitsPerEm, ascent, descent, capHeight, glyphIndex, advance, parts, contours: g => contours(g) }
}

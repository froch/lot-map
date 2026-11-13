// A pixel canvas: premultiplied RGBA, 8 bits a channel. Pixel (x, y) covers [x, x+1) × [y, y+1).
// Nothing here touches the engine.

export type Rgb = readonly [number, number, number]

/** Reads `#rgb` or `#rrggbb`. Anything else reads as black. */
export function parseColor(hex: string): Rgb {
  let h = hex.trim().replace(/^#/, '')
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1

/** One pixel at byte `i`, premultiplied in `d`, straight in `out`. */
function unpremultiply(d: Uint8Array, out: Uint8Array, i: number): void {
  const a = d[i + 3]!
  if (a === 255) {
    out[i] = d[i]!; out[i + 1] = d[i + 1]!; out[i + 2] = d[i + 2]!; out[i + 3] = 255
  } else if (a === 0) {
    out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0
  } else {
    const k = 255 / a
    out[i] = Math.min(255, Math.round(d[i]! * k)); out[i + 1] = Math.min(255, Math.round(d[i + 1]! * k)); out[i + 2] = Math.min(255, Math.round(d[i + 2]! * k)); out[i + 3] = a
  }
}

export class Canvas {
  readonly width: number
  readonly height: number
  /** Premultiplied RGBA, row by row. */
  readonly data: Uint8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.data = new Uint8Array(width * height * 4)
  }

  clear(): void {
    this.data.fill(0)
  }

  copyFrom(other: Canvas): void {
    this.data.set(other.data.length === this.data.length ? other.data : other.data.subarray(0, this.data.length))
  }

  /** Straight RGBA, 0–255. Outside the canvas reads as clear. */
  pixel(x: number, y: number): [number, number, number, number] {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return [0, 0, 0, 0]
    const i = (y * this.width + x) * 4
    const d = this.data
    const a = d[i + 3]!
    if (a === 255) return [d[i]!, d[i + 1]!, d[i + 2]!, 255]
    if (a === 0) return [0, 0, 0, 0]
    const k = 255 / a
    return [Math.min(255, Math.round(d[i]! * k)), Math.min(255, Math.round(d[i + 1]! * k)), Math.min(255, Math.round(d[i + 2]! * k)), a]
  }

  private straight: Uint8Array | null = null
  private straight32: Uint32Array | null = null
  private data32: Uint32Array | null = null

  /**
   * The picture as straight RGBA bytes, in a buffer this canvas reuses: valid until the next call.
   * Opaque and clear pixels go across a word at a time; on a little-endian machine alpha is a word's top byte.
   */
  toStraight(): Uint8Array {
    const d = this.data
    const out = (this.straight ??= new Uint8Array(d.length))
    if (!LITTLE_ENDIAN) {
      for (let i = 0; i < d.length; i += 4) unpremultiply(d, out, i)
      return out
    }
    const src = (this.data32 ??= new Uint32Array(d.buffer, d.byteOffset, d.length >> 2))
    const dst = (this.straight32 ??= new Uint32Array(out.buffer, out.byteOffset, out.length >> 2))
    for (let p = 0; p < src.length; p++) {
      const w = src[p]!
      const a = w >>> 24
      if (a === 255 || a === 0) dst[p] = a === 0 ? 0 : w
      else unpremultiply(d, out, p << 2)
    }
    return out
  }

  /** The picture as straight RGBA, base64. */
  toBase64(): string {
    return (this.toStraight() as unknown as { toBase64(): string }).toBase64()
  }

  /** Source-over of one colour at `sa` (0–1) on one pixel. */
  blend(i: number, color: Rgb, sa: number): void {
    if (sa <= 0) return
    const d = this.data
    if (sa >= 0.999) {
      d[i] = color[0]; d[i + 1] = color[1]; d[i + 2] = color[2]; d[i + 3] = 255
      return
    }
    const k = 1 - sa
    d[i] = Math.round(color[0] * sa + d[i]! * k)
    d[i + 1] = Math.round(color[1] * sa + d[i + 1]! * k)
    d[i + 2] = Math.round(color[2] * sa + d[i + 2]! * k)
    d[i + 3] = Math.round(255 * sa + d[i + 3]! * k)
  }
}

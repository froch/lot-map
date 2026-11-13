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

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

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

  /** The picture as straight RGBA, base64. */
  toBase64(): string {
    const d = this.data
    const n = d.length
    const out: number[] = []
    const parts: string[] = []
    let b0 = 0
    let b1 = 0
    let have = 0
    const push = (b: number) => {
      if (have === 0) { b0 = b; have = 1; return }
      if (have === 1) { b1 = b; have = 2; return }
      const v = (b0 << 16) | (b1 << 8) | b
      out.push(B64.charCodeAt(v >> 18), B64.charCodeAt((v >> 12) & 63), B64.charCodeAt((v >> 6) & 63), B64.charCodeAt(v & 63))
      have = 0
      if (out.length >= 8192) {
        parts.push(String.fromCharCode(...out))
        out.length = 0
      }
    }
    for (let i = 0; i < n; i += 4) {
      const a = d[i + 3]!
      if (a === 255) {
        push(d[i]!); push(d[i + 1]!); push(d[i + 2]!); push(255)
      } else if (a === 0) {
        push(0); push(0); push(0); push(0)
      } else {
        const k = 255 / a
        push(Math.min(255, Math.round(d[i]! * k))); push(Math.min(255, Math.round(d[i + 1]! * k))); push(Math.min(255, Math.round(d[i + 2]! * k))); push(a)
      }
    }
    if (have === 1) {
      const v = b0 << 16
      out.push(B64.charCodeAt(v >> 18), B64.charCodeAt((v >> 12) & 63), 61, 61)
    } else if (have === 2) {
      const v = (b0 << 16) | (b1 << 8)
      out.push(B64.charCodeAt(v >> 18), B64.charCodeAt((v >> 12) & 63), B64.charCodeAt((v >> 6) & 63), 61)
    }
    parts.push(String.fromCharCode(...out))
    return parts.join('')
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

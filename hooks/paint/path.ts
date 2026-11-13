// Shapes as polylines, and the anti-aliased fill and stroke that draw them. Nothing here touches the engine.
// Pixel (x, y) covers [x, x+1) × [y, y+1) and is sampled at its centre.
import type { Canvas, Rgb } from './canvas'

export type Point = { x: number; y: number }
export type Polyline = { points: Point[]; closed: boolean }
/** SVG `matrix(a b c d e f)`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Matrix = readonly [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]
const TOLERANCE = 0.2

export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export const scale = (k: number): Matrix => [k, 0, 0, k, 0, 0]
/** `a` after `b`: the result applies `b` first. */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}
export function rotateAbout(degrees: number, cx: number, cy: number): Matrix {
  const t = (degrees * Math.PI) / 180
  const c = Math.cos(t)
  const s = Math.sin(t)
  return multiply(translate(cx, cy), multiply([c, s, -s, c, 0, 0], translate(-cx, -cy)))
}

const apply = (m: Matrix, x: number, y: number): Point => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })
const stretch = (m: Matrix) => Math.max(Math.hypot(m[0], m[1]), Math.hypot(m[2], m[3]), 1e-9)

// ---- parsing ---------------------------------------------------------------------------------

/** Segments of one arc in user space, as points after the start. */
function arcPoints(x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, x2: number, y2: number, k: number): Point[] {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (x1 === x2 && y1 === y2) return []
  if (rx === 0 || ry === 0) return [{ x: x2, y: y2 }]
  const phi = (phiDeg * Math.PI) / 180
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const dx = (x1 - x2) / 2
  const dy = (y1 - y2) / 2
  const x1p = cp * dx + sp * dy
  const y1p = -sp * dx + cp * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den))
  if (large === sweep) co = -co
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sweep && dth > 0) dth -= 2 * Math.PI
  else if (sweep && dth < 0) dth += 2 * Math.PI
  const r = Math.max(rx, ry) * k
  const step = r <= TOLERANCE ? Math.PI / 2 : 2 * Math.acos(Math.max(0, 1 - TOLERANCE / r))
  let n = Math.max(1, Math.ceil(Math.abs(dth) / Math.max(step, 0.05)))
  if (Math.abs(dth) >= Math.PI - 1e-9 && n % 2 === 1) n++
  const out: Point[] = []
  for (let i = 1; i <= n; i++) {
    if (i === n) { out.push({ x: x2, y: y2 }); break }
    const t = th1 + (dth * i) / n
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    out.push({ x: cp * ex - sp * ey + cx, y: sp * ex + cp * ey + cy })
  }
  return out
}

export function parsePath(d: string, m: Matrix = IDENTITY): Polyline[] {
  const k = stretch(m)
  const lines: Polyline[] = []
  let cur: Point[] | null = null
  let x = 0
  let y = 0
  let sx = 0
  let sy = 0
  // control point of the last curve, for S and T-like reflection
  let lcx = 0
  let lcy = 0
  let lastKind: 'c' | 'q' | '' = ''
  const add = (px: number, py: number) => {
    if (!cur) {
      cur = [apply(m, sx, sy)]
      lines.push({ points: cur, closed: false })
    }
    cur.push(apply(m, px, py))
  }
  let pos = 0
  let cmd = ''
  const skip = () => { while (pos < d.length && /[\s,]/.test(d[pos]!)) pos++ }
  const NUM = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y
  const num = (): number => {
    skip()
    NUM.lastIndex = pos
    const mt = NUM.exec(d)
    if (!mt) throw new Error('number expected')
    pos = NUM.lastIndex
    return Number(mt[0])
  }
  // a flag is one character, 0 or 1, and may run straight into the next number
  const flag = (): boolean => {
    skip()
    const ch = d[pos]
    if (ch !== '0' && ch !== '1') throw new Error('flag expected')
    pos++
    return ch === '1'
  }
  for (;;) {
    skip()
    if (pos >= d.length) break
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(d[pos]!)) { cmd = d[pos]!; pos++ }
    else if (!cmd) break
    else if (cmd === 'M') cmd = 'L'
    else if (cmd === 'm') cmd = 'l'
    else if (cmd === 'Z' || cmd === 'z') break
    const rel = cmd === cmd.toLowerCase()
    const up = cmd.toUpperCase()
    const ox = rel ? x : 0
    const oy = rel ? y : 0
    if (up === 'Z') {
      if (cur) (lines[lines.length - 1] as Polyline).closed = true
      cur = null
      x = sx
      y = sy
      lastKind = ''
      continue
    }
    if (up === 'M') {
      x = ox + num(); y = oy + num(); sx = x; sy = y; cur = null
      lastKind = ''
      // a lone M draws nothing, but a later L starts here
      continue
    }
    if (up === 'L') { x = ox + num(); y = oy + num(); add(x, y); lastKind = '' }
    else if (up === 'H') { x = ox + num(); add(x, y); lastKind = '' }
    else if (up === 'V') { y = oy + num(); add(x, y); lastKind = '' }
    else if (up === 'C' || up === 'S') {
      let x1: number, y1: number
      if (up === 'C') { x1 = ox + num(); y1 = oy + num() }
      else if (lastKind === 'c') { x1 = 2 * x - lcx; y1 = 2 * y - lcy }
      else { x1 = x; y1 = y }
      const x2 = ox + num(); const y2 = oy + num(); const x3 = ox + num(); const y3 = oy + num()
      add(x, y); cur!.pop()
      cubic(cur!, apply(m, x, y), apply(m, x1, y1), apply(m, x2, y2), apply(m, x3, y3))
      lcx = x2; lcy = y2; x = x3; y = y3; lastKind = 'c'
    } else if (up === 'Q' || up === 'T') {
      let x1: number, y1: number
      if (up === 'Q') { x1 = ox + num(); y1 = oy + num() }
      else if (lastKind === 'q') { x1 = 2 * x - lcx; y1 = 2 * y - lcy }
      else { x1 = x; y1 = y }
      const x2 = ox + num(); const y2 = oy + num()
      add(x, y); cur!.pop()
      quad(cur!, apply(m, x, y), apply(m, x1, y1), apply(m, x2, y2))
      lcx = x1; lcy = y1; x = x2; y = y2; lastKind = 'q'
    } else if (up === 'A') {
      const rx = num(); const ry = num(); const rot = num()
      const large = flag(); const sweep = flag()
      const ex = ox + num(); const ey = oy + num()
      add(x, y); cur!.pop()
      for (const p of arcPoints(x, y, rx, ry, rot, large, sweep, ex, ey, k)) cur!.push(apply(m, p.x, p.y))
      x = ex; y = ey; lastKind = ''
    } else break
  }
  return lines.filter(l => l.points.length > 1 || l.closed)
}

function cubic(out: Point[], p0: Point, p1: Point, p2: Point, p3: Point): void {
  const m = Math.max(Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y), Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y))
  const n = Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / TOLERANCE)))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    const a = u * u * u; const b = 3 * u * u * t; const c = 3 * u * t * t; const e = t * t * t
    out.push({ x: a * p0.x + b * p1.x + c * p2.x + e * p3.x, y: a * p0.y + b * p1.y + c * p2.y + e * p3.y })
  }
}

function quad(out: Point[], p0: Point, p1: Point, p2: Point): void {
  const m = Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y)
  const n = Math.max(1, Math.ceil(Math.sqrt(m / (4 * TOLERANCE))))
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    out.push({ x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y })
  }
}

// ---- shapes ----------------------------------------------------------------------------------

export function ellipse(cx: number, cy: number, rx: number, ry: number, m: Matrix = IDENTITY): Polyline[] {
  const r = Math.max(Math.abs(rx), Math.abs(ry)) * stretch(m)
  const step = r <= TOLERANCE ? Math.PI / 2 : 2 * Math.acos(Math.max(0, 1 - TOLERANCE / r))
  let n = Math.max(8, Math.ceil((2 * Math.PI) / step))
  if (n % 4) n += 4 - (n % 4)
  const points: Point[] = []
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n
    points.push(apply(m, cx + rx * Math.cos(t), cy + ry * Math.sin(t)))
  }
  return [{ points, closed: true }]
}

export const circle = (cx: number, cy: number, r: number, m: Matrix = IDENTITY): Polyline[] => ellipse(cx, cy, r, r, m)

export function roundRect(x: number, y: number, w: number, h: number, r: number, m: Matrix = IDENTITY): Polyline[] {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  const pts: Point[] = []
  const corner = (cx: number, cy: number, from: number) => {
    const big = rr * stretch(m)
    const step = big <= TOLERANCE ? Math.PI / 2 : 2 * Math.acos(Math.max(0, 1 - TOLERANCE / big))
    const n = Math.max(1, Math.ceil(Math.PI / 2 / step))
    for (let i = 0; i <= n; i++) {
      const t = from + ((Math.PI / 2) * i) / n
      pts.push({ x: cx + rr * Math.cos(t), y: cy + rr * Math.sin(t) })
    }
  }
  if (rr === 0) pts.push({ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h })
  else {
    corner(x + w - rr, y + rr, -Math.PI / 2)
    corner(x + w - rr, y + h - rr, 0)
    corner(x + rr, y + h - rr, Math.PI / 2)
    corner(x + rr, y + rr, Math.PI)
  }
  return [{ points: pts.map(p => apply(m, p.x, p.y)), closed: true }]
}

export const line = (x1: number, y1: number, x2: number, y2: number, m: Matrix = IDENTITY): Polyline[] => [
  { points: [apply(m, x1, y1), apply(m, x2, y2)], closed: false },
]

// ---- dashes ----------------------------------------------------------------------------------

export function dashed(lines: Polyline[], pattern: readonly number[], offset: number, pathLength?: number): Polyline[] {
  const base = pattern.filter(v => v >= 0)
  if (base.length === 0 || base.some(v => !Number.isFinite(v))) return lines
  const cycle = base.length % 2 ? [...base, ...base] : base
  const total = cycle.reduce((a, b) => a + b, 0)
  if (total <= 0) return lines
  const out: Polyline[] = []
  for (const l of lines) {
    const pts = l.closed && l.points.length > 0 ? [...l.points, l.points[0]!] : l.points
    if (pts.length < 2) continue
    let len = 0
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
    if (len === 0) continue
    const k = pathLength && pathLength > 0 ? len / pathLength : 1
    // find where in the pattern the path starts
    let phase = (((offset * k) % (total * k)) + total * k) % (total * k)
    let idx = 0
    let left = cycle[0]! * k
    while (phase > 0) {
      if (phase >= left) { phase -= left; idx = (idx + 1) % cycle.length; left = cycle[idx]! * k }
      else { left -= phase; phase = 0 }
    }
    let piece: Point[] | null = null
    const eps = 1e-9 * Math.max(1, len)
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!
      const b = pts[i]!
      const sl = Math.hypot(b.x - a.x, b.y - a.y)
      let pos = 0
      while (sl - pos > eps) {
        const on = idx % 2 === 0
        const run = Math.min(left, sl - pos)
        if (on && !piece) piece = [{ x: a.x + ((b.x - a.x) * pos) / sl, y: a.y + ((b.y - a.y) * pos) / sl }]
        pos += run
        left -= run
        if (on) piece!.push({ x: a.x + ((b.x - a.x) * pos) / sl, y: a.y + ((b.y - a.y) * pos) / sl })
        if (left <= eps) {
          if (on && piece) { out.push({ points: piece, closed: false }); piece = null }
          idx = (idx + 1) % cycle.length
          left = cycle[idx]! * k
          // a zero-length entry would never advance; step over it
          let guard = 0
          while (left <= eps && guard++ < cycle.length) {
            idx = (idx + 1) % cycle.length
            left = cycle[idx]! * k
          }
        }
      }
    }
    if (piece && piece.length > 1) out.push({ points: piece, closed: false })
  }
  return out
}

// ---- fill ------------------------------------------------------------------------------------

const SUB = 8

/** Non-zero winding, exact horizontal coverage over SUB sub-scanlines a pixel row. Source-over. */
export function fill(c: Canvas, shape: Polyline[], color: Rgb, alpha: number): void {
  if (alpha <= 0) return
  type Edge = { x0: number; y0: number; x1: number; y1: number; dir: number }
  const edges: Edge[] = []
  let minY = Infinity
  let maxY = -Infinity
  for (const l of shape) {
    const p = l.points
    if (p.length < 2) continue
    for (let i = 0; i < p.length; i++) {
      const a = p[i]!
      const b = p[(i + 1) % p.length]!
      if (a.y === b.y) continue
      edges.push(a.y < b.y ? { x0: a.x, y0: a.y, x1: b.x, y1: b.y, dir: 1 } : { x0: b.x, y0: b.y, x1: a.x, y1: a.y, dir: -1 })
      minY = Math.min(minY, a.y, b.y)
      maxY = Math.max(maxY, a.y, b.y)
    }
  }
  if (edges.length === 0) return
  const row0 = Math.max(0, Math.floor(minY))
  const row1 = Math.min(c.height - 1, Math.ceil(maxY) - 1)
  if (row1 < row0) return
  const buckets: Edge[][] = []
  for (let r = row0; r <= row1; r++) buckets.push([])
  for (const e of edges) {
    const a = Math.max(row0, Math.floor(e.y0))
    const b = Math.min(row1, Math.ceil(e.y1) - 1)
    for (let r = a; r <= b; r++) buckets[r - row0]!.push(e)
  }
  const w = c.width
  const cov = new Float32Array(w)
  const xs: { x: number; dir: number }[] = []
  for (let r = row0; r <= row1; r++) {
    const es = buckets[r - row0]!
    if (es.length === 0) continue
    cov.fill(0)
    let lo = w
    let hi = -1
    for (let s = 0; s < SUB; s++) {
      const sy = r + (s + 0.5) / SUB
      xs.length = 0
      for (const e of es) {
        if (sy < e.y0 || sy >= e.y1) continue
        xs.push({ x: e.x0 + ((sy - e.y0) * (e.x1 - e.x0)) / (e.y1 - e.y0), dir: e.dir })
      }
      if (xs.length < 2) continue
      xs.sort((a, b) => a.x - b.x)
      let wind = 0
      for (let i = 0; i < xs.length - 1; i++) {
        wind += xs[i]!.dir
        if (wind === 0) continue
        const xa = Math.max(0, xs[i]!.x)
        const xb = Math.min(w, xs[i + 1]!.x)
        if (xb <= xa) continue
        const ia = Math.floor(xa)
        const ib = Math.min(w - 1, Math.floor(xb))
        if (ia < lo) lo = ia
        if (ib > hi) hi = ib
        if (ia === ib) { cov[ia]! += xb - xa; continue }
        cov[ia]! += ia + 1 - xa
        for (let x = ia + 1; x < ib; x++) cov[x]! += 1
        cov[ib]! += xb - ib
      }
    }
    for (let x = lo; x <= hi; x++) {
      const v = cov[x]!
      if (v > 0) c.blend((r * w + x) * 4, color, Math.min(1, v / SUB) * alpha)
    }
  }
}

// ---- stroke ----------------------------------------------------------------------------------

/** Distance-to-segment coverage over each polyline's bounding box; joins round, ends butt or round. */
export function stroke(c: Canvas, lines: Polyline[], width: number, color: Rgb, alpha: number, cap: 'butt' | 'round'): void {
  if (alpha <= 0 || width <= 0) return
  const hw = width / 2
  const reach = hw + 1
  for (const l of lines) {
    const pts = l.points
    if (pts.length === 0) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of pts) {
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    const x0 = Math.max(0, Math.floor(minX - reach))
    const y0 = Math.max(0, Math.floor(minY - reach))
    const x1 = Math.min(c.width - 1, Math.ceil(maxX + reach))
    const y1 = Math.min(c.height - 1, Math.ceil(maxY + reach))
    if (x1 < x0 || y1 < y0) continue
    const bw = x1 - x0 + 1
    const bh = y1 - y0 + 1
    const cov = new Float32Array(bw * bh)
    const segs: { a: Point; b: Point; roundA: boolean; roundB: boolean }[] = []
    const n = l.closed ? pts.length : pts.length - 1
    if (pts.length === 1 || (n >= 1 && pts.every(p => p.x === pts[0]!.x && p.y === pts[0]!.y))) {
      if (cap === 'round' || l.closed) segs.push({ a: pts[0]!, b: pts[0]!, roundA: true, roundB: true })
    } else {
      for (let i = 0; i < n; i++) {
        const a = pts[i]!
        const b = pts[(i + 1) % pts.length]!
        if (a.x === b.x && a.y === b.y) continue
        const first = !l.closed && i === 0
        const last = !l.closed && i === n - 1
        segs.push({ a, b, roundA: !first || cap === 'round', roundB: !last || cap === 'round' })
      }
    }
    for (const s of segs) {
      const dx = s.b.x - s.a.x
      const dy = s.b.y - s.a.y
      const len = Math.hypot(dx, dy)
      const ux = len ? dx / len : 1
      const uy = len ? dy / len : 0
      const sx0 = Math.max(x0, Math.floor(Math.min(s.a.x, s.b.x) - reach))
      const sx1 = Math.min(x1, Math.ceil(Math.max(s.a.x, s.b.x) + reach))
      const sy0 = Math.max(y0, Math.floor(Math.min(s.a.y, s.b.y) - reach))
      const sy1 = Math.min(y1, Math.ceil(Math.max(s.a.y, s.b.y) + reach))
      for (let y = sy0; y <= sy1; y++) {
        for (let x = sx0; x <= sx1; x++) {
          const px = x + 0.5 - s.a.x
          const py = y + 0.5 - s.a.y
          const t = px * ux + py * uy
          const perp = Math.abs(px * -uy + py * ux)
          let v: number
          if (t < 0 && s.roundA) v = hw + 0.5 - Math.hypot(px, py)
          else if (t > len && s.roundB) v = hw + 0.5 - Math.hypot(px - dx, py - dy)
          else {
            v = Math.min(1, hw + 0.5 - perp)
            if (!s.roundA && t < 0.5) v = Math.min(v, t + 0.5)
            if (!s.roundB && t > len - 0.5) v = Math.min(v, len - t + 0.5)
          }
          if (v <= 0) continue
          if (v > 1) v = 1
          const i = (y - y0) * bw + (x - x0)
          if (v > cov[i]!) cov[i] = v
        }
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const v = cov[(y - y0) * bw + (x - x0)]!
        if (v > 0) c.blend((y * c.width + x) * 4, color, v * alpha)
      }
    }
  }
}

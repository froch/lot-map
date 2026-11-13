import { expect, test } from 'claude-code/testing'
import { Canvas, parseColor } from './paint/canvas'
import { circle, dashed, fill, line, parsePath, rotateAbout, roundRect, stroke } from './paint/path'
import { STATIONS, setupFrom } from './map'
import { COVERAGE, STILL_TEXT, missing } from './paint/font'
import { FONT } from './paint/font-data'
import { drawText, textWidth } from './paint/text'
import { stringsFor } from './text'
import { isChanging, parseClock, sample, windowOf } from './paint/timeline'
import type { SceneNode } from './scene'

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)
const WHITE = parseColor('#ffffff')

test('a filled circle covers its middle, half of a pixel its edge cuts in two, and nothing outside', () => {
  const c = new Canvas(40, 40)
  fill(c, circle(20, 20, 10.5), parseColor('#e1ac6e'), 1)
  expect(c.pixel(20, 20)).toEqual([225, 172, 110, 255])
  expect(c.pixel(2, 2)).toEqual([0, 0, 0, 0])
  const edge = c.pixel(30, 20)[3]
  expect(edge).toBeGreaterThan(60)
  expect(edge).toBeLessThan(200)
})

test('a rounded rect leaves its corners clear', () => {
  const c = new Canvas(100, 80)
  fill(c, roundRect(0, 0, 100, 80, 19.2), parseColor('#0a0c11'), 1)
  expect(c.pixel(0, 0)[3]).toBe(0)
  expect(c.pixel(50, 40)).toEqual([10, 12, 17, 255])
})

test('a ring over pathLength 1 with dash offset .75 shows its first quarter, from the top clockwise', () => {
  const c = new Canvas(60, 60)
  stroke(c, dashed(circle(30, 30, 20, rotateAbout(-90, 30, 30)), [1, 1], 0.75, 1), 3, WHITE, 1, 'butt')
  expect(c.pixel(44, 16)[3]).toBeGreaterThan(200)
  expect(c.pixel(16, 44)[3]).toBe(0)
  expect(c.pixel(16, 16)[3]).toBe(0)
})

test('dashes 2 on 5 off cut a line into pieces two long', () => {
  const pieces = dashed(line(0, 0, 70, 0), [2, 5], 0)
  expect(pieces.length).toBe(10)
  for (const p of pieces) near(Math.abs(p.points[p.points.length - 1]!.x - p.points[0]!.x), 2, 1e-5)
})

test('every station icon parses, arcs and smooth curves included, inside its 20-unit box', () => {
  for (const s of STATIONS) {
    const pts = parsePath(s.icon).flatMap(p => p.points)
    expect(pts.length).toBeGreaterThan(3)
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThan(10)
      expect(Math.abs(p.y)).toBeLessThan(10)
    }
  }
  const you = parsePath(STATIONS[0]!.icon).flatMap(p => p.points)
  near(Math.min(...you.map(p => p.y)), -7, 0.3)
  near(Math.max(...you.map(p => p.x)), 6.5, 0.05)
})

test('a round-capped stroke reaches half its width past the end of the line; a butt one stops there', () => {
  const c = new Canvas(40, 20)
  stroke(c, line(10, 10, 30, 10), 6, WHITE, 1, 'round')
  expect(c.pixel(32, 10)[3]).toBeGreaterThan(200)
  const butt = new Canvas(40, 20)
  stroke(butt, line(10, 10, 30, 10), 6, WHITE, 1, 'butt')
  expect(butt.pixel(31, 10)[3]).toBe(0)
})

test('arc flags may run into the next number', () => {
  const a = parsePath('M0 0a2 2 0 01-2 2')[0]!.points
  near(a[a.length - 1]!.x, -2)
  near(a[a.length - 1]!.y, 2)
  const b = parsePath('M0 0a1 1 0 0110 10')[0]!.points
  near(b[b.length - 1]!.x, 10)
  near(b[b.length - 1]!.y, 10)
})

test('toBase64 gives straight RGBA', () => {
  const c = new Canvas(3, 1)
  fill(c, roundRect(0, 0, 1, 1, 0), parseColor('#102030'), 1)
  fill(c, roundRect(1, 0, 1, 1, 0), parseColor('#ff8000'), 0.5)
  const bytes = (Uint8Array as unknown as { fromBase64(s: string): Uint8Array }).fromBase64(c.toBase64())
  expect(Array.from(bytes.slice(0, 4))).toEqual([16, 32, 48, 255])
  expect(Array.from(bytes.slice(8, 12))).toEqual([0, 0, 0, 0])
  const mid = Array.from(bytes.slice(4, 8))
  near(mid[0]!, 255, 1.5)
  near(mid[1]!, 128, 1.5)
  expect(mid[2]).toBe(0)
  near(mid[3]!, 128, 1.5)
})

test('a round cap shows no dent next to it', () => {
  const c = new Canvas(40, 20)
  stroke(c, line(10.2, 10, 30, 10), 6, WHITE, 1, 'round')
  expect(c.pixel(10, 10)[3]).toBe(255)
  expect(c.pixel(9, 10)[3]).toBe(255)
})

test('parseColor reads #rgb and #rrggbb, and reads anything else as black', () => {
  expect(parseColor('#fa0')).toEqual([255, 170, 0])
  expect(parseColor('#e1ac6e')).toEqual([225, 172, 110])
  expect(parseColor('nope')).toEqual([0, 0, 0])
})

test('copyFrom copies pixels', () => {
  const a = new Canvas(4, 4)
  fill(a, roundRect(0, 0, 4, 4, 0), parseColor('#336699'), 1)
  const b = new Canvas(4, 4)
  b.copyFrom(a)
  expect(b.pixel(2, 2)).toEqual([51, 102, 153, 255])
})

test('half-alpha source-over on an opaque colour gives the mixed colour', () => {
  const c = new Canvas(2, 2)
  fill(c, roundRect(0, 0, 2, 2, 0), parseColor('#000000'), 1)
  fill(c, roundRect(0, 0, 2, 2, 0), parseColor('#ffffff'), 0.5)
  const p = c.pixel(1, 1)
  near(p[0], 128, 1.5)
  expect(p[3]).toBe(255)
})

test('relative commands end where the absolute ones do', () => {
  const end = (d: string) => { const p = parsePath(d)[0]!.points; return p[p.length - 1]! }
  const e = end('m1 1l2 0h3v4')
  near(e.x, 6); near(e.y, 5)
  const c = end('m1 1c1 0 2 1 3 3s1 1 2 0')
  near(c.x, 6); near(c.y, 4)
  const q = end('m1 1q1 2 4 0')
  near(q.x, 5); near(q.y, 1)
  const z = parsePath('m1 1l4 0 0 4z')[0]!
  expect(z.closed).toBe(true)
  const q2 = end('M1 1Q3 3 5 1')
  near(q2.x, 5); near(q2.y, 1)
})

test('non-zero winding keeps same-direction nesting filled and cuts a reverse-direction hole', () => {
  const sq = (x: number, y: number, s: number, rev: boolean) => {
    const pts = [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }]
    return { points: rev ? pts.reverse() : pts, closed: true }
  }
  const same = new Canvas(20, 20)
  fill(same, [sq(1, 1, 18, false), sq(6, 6, 8, false)], WHITE, 1)
  expect(same.pixel(10, 10)[3]).toBe(255)
  const hole = new Canvas(20, 20)
  fill(hole, [sq(1, 1, 18, false), sq(6, 6, 8, true)], WHITE, 1)
  expect(hole.pixel(10, 10)[3]).toBe(0)
  expect(hole.pixel(3, 3)[3]).toBe(255)
})

const inkColumns = (c: Canvas): [number, number] => {
  let l = c.width, r = -1
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (c.pixel(x, y)[3] > 0) { l = Math.min(l, x); r = Math.max(r, x) }
  return [l, r]
}

test('the font covers every character the map can draw', () => {
  expect(missing(FONT, COVERAGE)).toEqual([])
})

test('the still text holds every station name in en, ru and de', () => {
  const names = ['en', 'ru', 'de'].flatMap(l => Object.values(stringsFor(l).stations)).join('')
  expect([...names].filter(ch => !STILL_TEXT.includes(ch))).toEqual([])
})

test('text anchored in the middle is centred on x less half the trailing letter-spacing', () => {
  const adv = (FONT.regular.advance / FONT.regular.unitsPerEm) * 20
  near(textWidth(FONT, 'HHH', 20, 4), 3 * (adv + 4))
  const c = new Canvas(200, 40)
  drawText(c, FONT, { runs: [{ text: 'HHH', color: WHITE }], x: 100, y: 30, size: 20, anchor: 'middle', letterSpacing: 4 })
  const [l, r] = inkColumns(c)
  near((l + r + 1) / 2, 98, 0.75)
})

test('a character the font lacks is a hollow box, and nothing throws', () => {
  {
    const c = new Canvas(60, 40)
    drawText(c, FONT, { runs: [{ text: '日', color: WHITE }], x: 10, y: 30, size: 20, anchor: 'start' })
    const [l, r] = inkColumns(c)
    expect(r - l).toBeGreaterThan(8)
    expect(c.pixel(Math.round((l + r) / 2), 24)[3]).toBe(0)
  }
})

test('a rim is drawn around the letters in its own colour', () => {
  const c = new Canvas(80, 40)
  drawText(c, FONT, { runs: [{ text: 'O', color: WHITE }], x: 40, y: 30, size: 24, anchor: 'middle', rim: { color: parseColor('#0a0c11'), width: 5.6 } })
  let x = 0
  while (x < c.width && c.pixel(x, 22)[3] < 255) x++
  expect(c.pixel(x, 22)).toEqual([10, 12, 17, 255])
})

test('one stroke call paints a pixel once, even where its lines cross', () => {
  const c = new Canvas(40, 40)
  stroke(c, [...line(5, 20.5, 35, 20.5), ...line(20.5, 5, 20.5, 35)], 4, WHITE, 0.5, 'butt')
  const away = c.pixel(10, 20)[3]
  expect(away).toBeGreaterThan(100)
  // whole numbers, so this is "within 1"
  near(c.pixel(20, 20)[3], away, 1.5)
})

const anim = (attrs: Record<string, string>): SceneNode => ({ tag: 'animate', attrs: Object.entries(attrs), motion: 'slow' })
const el = (...children: SceneNode[]): SceneNode => ({ tag: 'circle', attrs: [['opacity', '0']], children })

test('clock strings read as milliseconds', () => {
  expect([parseClock('0.800s'), parseClock('-1.234s'), parseClock('.5s'), parseClock('1.4s')]).toEqual([800, -1234, 500, 1400])
})

test('an opacity fade interpolates, freezes at its end, and does not apply before it begins', () => {
  const n = el(anim({ attributeName: 'opacity', values: '.75;0', begin: '-0.100s', dur: '1.600s', fill: 'freeze' }))
  near(sample(n, 1000, 1000).values.get('opacity')!, 0.703125)
  expect(sample(n, 1000, 3000).values.get('opacity')).toBe(0)
  const late = el(anim({ attributeName: 'opacity', values: '.7;0', begin: '0.500s', dur: '0.450s' }))
  expect(sample(late, 1000, 1200).values.has('opacity')).toBe(false)
  expect(sample(late, 1000, 2000).values.has('opacity')).toBe(false)
})

test('keyTimes hold a pulse at full strength and then fade it', () => {
  const n = el(anim({ attributeName: 'opacity', values: '1;1;0', keyTimes: '0;.82;1', begin: '0.000s', dur: '0.800s', fill: 'freeze' }))
  expect(sample(n, 0, 400).values.get('opacity')).toBe(1)
  near(sample(n, 0, 728).values.get('opacity')!, 0.5, 1e-3)
})

test('a counted repeat runs its laps and then freezes at its last value', () => {
  const n = el(anim({ attributeName: 'r', values: '40;66', begin: '0.000s', dur: '1.6s', repeatCount: '3', fill: 'freeze' }))
  near(sample(n, 0, 4000).values.get('r')!, 53)
  expect(sample(n, 0, 6000).values.get('r')).toBe(66)
  expect(windowOf(n.children![0] as SceneNode, 0)).toEqual({ from: 0, to: 4800 })
  expect([isChanging(n, 0, -1), isChanging(n, 0, 100), isChanging(n, 0, 4800), isChanging(n, 0, 6000)]).toEqual([false, true, false, false])
})

test('of two opacity animations, the one that began later wins once it has begun', () => {
  const n = el(
    anim({ attributeName: 'opacity', values: '0;.85', begin: '0.400s', dur: '.15s', fill: 'freeze' }),
    anim({ attributeName: 'opacity', values: '.85;0', begin: '40.000s', dur: '20.000s', fill: 'freeze' }),
  )
  expect(sample(n, 0, 1000).values.get('opacity')).toBe(0.85)
  near(sample(n, 0, 50_000).values.get('opacity')!, 0.425)
})

test('motion along a line and rotation about a point', () => {
  const move: SceneNode = { tag: 'circle', attrs: [], children: [{ tag: 'animateMotion', attrs: [['path', 'M0 0L10 0'], ['begin', '0.000s'], ['dur', '0.800s'], ['fill', 'freeze']], motion: 'fast' }] }
  expect(sample(move, 0, 400).offset).toEqual({ x: 5, y: 0 })
  const spin: SceneNode = { tag: 'g', attrs: [], children: [{ tag: 'animateTransform', attrs: [['attributeName', 'transform'], ['type', 'rotate'], ['from', '0 50 50'], ['to', '360 50 50'], ['begin', '-1.750s'], ['dur', '7.000s'], ['repeatCount', 'indefinite']], motion: 'slow' }] }
  expect(sample(spin, 0, 0).rotate).toEqual({ degrees: 90, cx: 50, cy: 50 })
})

import { expect, test } from 'claude-code/testing'
import { Canvas, parseColor } from './paint/canvas'
import { circle, dashed, fill, line, parsePath, rotateAbout, roundRect, stroke } from './paint/path'
import { STATIONS, setupFrom } from './map'

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

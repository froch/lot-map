import { expect, test } from 'bun:test'
import { GENERATION_SPAN, NameRing, firstGeneration } from './ring'
import type { Shm } from './shm'

const fakeShm = () => {
  const live = new Map<string, Uint8Array>()
  const shm: Shm = {
    put: (name, bytes) => (live.has(name) ? -17 : (live.set(name, bytes), 0)),
    drop: name => (live.delete(name) ? 0 : -2),
    read: name => live.get(name),
  }
  return { shm, live }
}

test('frames go round eight names with rising generations; all eight unread skips the frame', () => {
  const { shm, live } = fakeShm()
  const ring = new NameRing('abcd1234', shm, 8, 1000)
  const written = Array.from({ length: 8 }, (_, k) => ring.write(new Uint8Array([k]), k)!)
  expect(new Set(written.map(w => w.name)).size).toBe(8)
  expect(written.every(w => /^\/lm-abcd1234-[0-7]$/.test(w.name))).toBe(true)
  expect(written.map(w => w.generation)).toEqual([1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007])
  expect(ring.write(new Uint8Array([9]), 9)).toBeUndefined()
  live.delete(written[3]!.name)
  expect(ring.write(new Uint8Array([10]), 10)).toEqual({ name: written[3]!.name, generation: 1008 })
})

test('by default the first generation is the clock at start modulo 10^9, so a restarted ring never repeats a name with its generation', () => {
  const { shm, live } = fakeShm()
  const before = Date.now()
  const first = new NameRing('abcd1234', shm).write(new Uint8Array([1]), 0)!
  const after = Date.now()
  const possible = Array.from({ length: after - before + 1 }, (_, k) => firstGeneration(before + k))
  expect(possible).toContain(first.generation)
  live.clear()
  const again = new NameRing('abcd1234', shm, 8, first.generation + 1).write(new Uint8Array([1]), 0)!
  expect(again.name).toBe(first.name)
  expect(again.generation).toBeGreaterThan(first.generation)
})

test('the default first generation is a small whole number: positive and below 2^30, whatever the clock', () => {
  const { shm } = fakeShm()
  const own = new NameRing('abcd1234', shm).write(new Uint8Array([1]), 0)!.generation
  for (const g of [own, firstGeneration(Date.now()), firstGeneration(1_789_123_456_789), firstGeneration(8_640_000_000_000_000), firstGeneration(GENERATION_SPAN - 1)]) {
    expect(Number.isInteger(g)).toBe(true)
    expect(g).toBeGreaterThan(0)
    expect(g).toBeLessThan(2 ** 30)
  }
  expect(firstGeneration(1_789_123_456_789)).toBe(123_456_789)
  expect(firstGeneration(2_000_000_000_000)).toBe(1) // a clock on a whole span gives 1, not 0
})

test('clean drops all eight names, and expire drops frames unread after a second', () => {
  const { shm, live } = fakeShm()
  const ring = new NameRing('abcd1234', shm)
  ring.write(new Uint8Array([1]), 0)
  ring.write(new Uint8Array([2]), 900)
  expect(ring.expire(1500)).toBe(1)
  expect(live.size).toBe(1)
  ring.clean()
  expect(live.size).toBe(0)
})

test('clean also drops names left by a predecessor with the same tag', () => {
  const { shm, live } = fakeShm()
  for (let k = 0; k < 8; k++) live.set(`/lm-abcd1234-${k}`, new Uint8Array([k]))
  live.set('/lm-other123-0', new Uint8Array([0]))
  new NameRing('abcd1234', shm).clean()
  expect([...live.keys()]).toEqual(['/lm-other123-0'])
})

test('unread counts the frames written and not yet taken', () => {
  const { shm, live } = fakeShm()
  const ring = new NameRing('abcd1234', shm)
  const a = ring.write(new Uint8Array([1]), 0)!
  ring.write(new Uint8Array([2]), 0)
  expect(ring.unread()).toBe(2)
  live.delete(a.name)
  expect(ring.unread()).toBe(1)
})

test('a frame read before it expires is not counted as expired', () => {
  const { shm, live } = fakeShm()
  const ring = new NameRing('abcd1234', shm)
  const a = ring.write(new Uint8Array([1]), 0)!
  live.delete(a.name)
  expect(ring.expire(5000)).toBe(0)
})

test('a write failing for another reason than an unread name throws', () => {
  const shm: Shm = { put: () => -28, drop: () => 0, read: () => undefined }
  expect(() => new NameRing('abcd1234', shm).write(new Uint8Array([1]), 0)).toThrow(/28/)
})

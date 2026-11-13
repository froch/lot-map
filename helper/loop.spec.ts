import { expect, test } from 'bun:test'
import { FrameLoop } from './loop'
import type { HelperSetup } from './loop'
import { changedAt } from '../hooks/paint/motion'
import type { Scene } from '../hooks/scene'
import type { Board, Entry } from '../types'

// The Task 9 board helpers, copied in.
const NOW = 1_000_000
let seq = 0
const entry = (e: Partial<Entry> & Pick<Entry, 'station' | 'startedAt' | 'status'>): Entry => ({ id: `m${seq++}`, label: 'x', from: 'core', ...e })
const boardWith = (...entries: Entry[]): Board => ({ entries, counts: {} })

const fresh = (at = NOW) => boardWith(entry({ station: 'shell', startedAt: at - 100, status: 'run' }))
const long = () => boardWith(entry({ station: 'shell', startedAt: NOW - 30_000, status: 'run' }))
const idle = () => boardWith(entry({ station: 'shell', startedAt: NOW - 200_000, endedAt: NOW - 199_000, status: 'ok' }))
const stuck = (): Board => ({ ...boardWith(entry({ station: 'agents', startedAt: NOW - 400_000, status: 'run', from: 'agents', agentId: 'a1' })), agents: ['a1'] })

const SETUP: HelperSetup = { options: {}, light: false, rows: 20 }

/** A fake clock: `schedule` queues a callback by due time and returns a canceller; `run(ms)` advances through the queue, its end excluded. */
function fakeClock(start: number) {
  let now = start
  let order = 0
  const queue: { at: number; order: number; fn: () => void }[] = []
  return {
    now: () => now,
    schedule(ms: number, fn: () => void): () => void {
      const item = { at: now + Math.max(0, ms), order: order++, fn }
      queue.push(item)
      return () => {
        const i = queue.indexOf(item)
        if (i >= 0) queue.splice(i, 1)
      }
    },
    run(ms: number): void {
      const end = now + ms
      for (;;) {
        let next: (typeof queue)[number] | undefined
        for (const q of queue) if (q.at < end && (next === undefined || q.at < next.at || (q.at === next.at && q.order < next.order))) next = q
        if (next === undefined) break
        queue.splice(queue.indexOf(next), 1)
        now = next.at
        next.fn()
      }
      now = end
    },
    pending: () => queue.length,
  }
}

function harness(start = NOW) {
  const clock = fakeClock(start)
  const lines: string[] = []
  const painted: { scene: Scene; t: number; at: number }[] = []
  let generation = 0
  const loop = new FrameLoop({
    now: clock.now,
    paint: (scene, t) => {
      painted.push({ scene, t, at: clock.now() })
      return new Uint8Array(4)
    },
    write: () => {
      generation++
      return { name: `/lm-test0001-${(generation - 1) % 8}`, generation }
    },
    expire: () => 0,
    emit: line => lines.push(line),
    schedule: (ms, fn) => clock.schedule(ms, fn),
  })
  const count = (kind: string) => lines.filter(l => l.startsWith(`${kind} `)).length
  return { clock, loop, lines, painted, frames: () => count('F'), stats: () => count('S') }
}

const between = (n: number, lo: number, hi: number) => {
  expect(n).toBeGreaterThanOrEqual(lo)
  expect(n).toBeLessThanOrEqual(hi)
}

const start = (board: Board, h = harness(), now = NOW) => {
  h.loop.setSetup(SETUP)
  h.loop.setBoard(board, now, changedAt(board))
  return h
}

test('a fresh call paints about 20 frames a second', () => {
  const h = start(fresh())
  h.clock.run(1000)
  between(h.frames(), 19, 21)
  expect(h.loop.stats().state).toBe('running')
})

test('a long-running call paints about 15 frames a second', () => {
  const h = start(long())
  h.clock.run(1000)
  between(h.frames(), 14, 16)
})

test('an idle board paints exactly one last frame, then nothing for five seconds', () => {
  const h = start(idle())
  h.clock.run(1000)
  expect(h.frames()).toBe(1)
  h.clock.run(5000)
  expect(h.frames()).toBe(1)
  expect(h.loop.stats().state).toBe('still')
})

test('a run stuck with no board change for five minutes paints about once a second', () => {
  const h = harness()
  const board = stuck()
  h.loop.setSetup(SETUP)
  h.loop.setBoard(board, NOW, NOW - 300_000)
  h.clock.run(5000)
  between(h.frames(), 4, 6)
})

test('F lines carry the name, the picture size and the generation', () => {
  const h = start(idle())
  h.clock.run(10)
  expect(h.lines.filter(l => l.startsWith('F '))).toEqual(['F /lm-test0001-0 727 680 1'])
})

test('nothing paints until both the setup and a board have come, and a board before the setup is kept', () => {
  const h = harness()
  const board = idle()
  h.loop.setBoard(board, NOW, changedAt(board))
  h.clock.run(1000)
  expect(h.frames()).toBe(0)
  h.loop.setSetup(SETUP)
  h.clock.run(1000)
  expect(h.frames()).toBe(1)
  const g = harness()
  g.loop.setSetup(SETUP)
  g.clock.run(1000)
  expect(g.frames()).toBe(0)
})

test('resume while still paints one frame, and so does a new setup', () => {
  const h = start(idle())
  h.clock.run(1000)
  expect(h.frames()).toBe(1)
  h.loop.resume()
  h.clock.run(1000)
  expect(h.frames()).toBe(2)
  h.loop.setSetup({ ...SETUP, rows: 25 })
  h.clock.run(1000)
  expect(h.frames()).toBe(3)
  expect(h.lines.at(-1)).toMatch(/^F \S+ 909 850 3$/)
})

test('a paused loop paints nothing, keeps a new board for later, and resumes with one frame', () => {
  const h = start(fresh())
  h.clock.run(500)
  const before = h.frames()
  h.loop.pause()
  expect(h.loop.stats().state).toBe('paused')
  h.clock.run(2000)
  expect(h.frames()).toBe(before)
  const board = idle()
  h.loop.setBoard(board, h.clock.now(), changedAt(board))
  h.clock.run(2000)
  expect(h.frames()).toBe(before)
  h.loop.resume()
  h.clock.run(2000)
  expect(h.frames()).toBe(before + 1)
})

test('a board posted 5000 ms behind the clock is sampled 5000 ms behind it; one in step is sampled at the clock', () => {
  const h = harness()
  const board = fresh(NOW - 5000)
  h.loop.setSetup(SETUP)
  h.loop.setBoard(board, NOW - 5000, changedAt(board))
  h.clock.run(500)
  expect(h.painted[0]!.scene.now).toBe(NOW - 5000)
  expect(h.painted[0]!.t).toBe(h.painted[0]!.scene.now)
  expect(h.painted.length).toBeGreaterThan(5)
  expect(h.painted.every(p => p.t === p.at - 5000)).toBe(true)

  const g = harness()
  const near = fresh(NOW - 500)
  g.loop.setSetup(SETUP)
  g.loop.setBoard(near, NOW - 500, changedAt(near))
  g.clock.run(500)
  expect(g.painted[0]!.scene.now).toBe(NOW - 500)
  expect(g.painted.every(p => p.t === p.at)).toBe(true)
})

test('S lines come once a second while frames flow, and none while still', () => {
  const h = start(fresh())
  h.clock.run(3000)
  between(h.stats(), 2, 3)
  for (const line of h.lines.filter(l => l.startsWith('S '))) expect(line).toMatch(/^S \d+ \d+\.\d\d \d+\.\d\d \d+ skips=\d+ expired=\d+$/)
  const board = idle()
  h.loop.setBoard(board, h.clock.now(), changedAt(board))
  h.clock.run(100)
  const atRest = h.stats()
  const frames = h.frames()
  h.clock.run(5000)
  expect(h.stats()).toBe(atRest)
  expect(h.frames()).toBe(frames)
})

test('a new board replans at once, and boards in a burst never paint faster than 20 a second', () => {
  const h = start(idle())
  h.clock.run(1000)
  expect(h.frames()).toBe(1)
  for (let k = 0; k < 10; k++) {
    const board = idle()
    h.loop.setBoard(board, h.clock.now(), changedAt(board))
    h.clock.run(10)
  }
  h.clock.run(1000)
  between(h.frames(), 2, 4)
  expect(h.clock.pending()).toBeLessThanOrEqual(1)
})

test('a full ring skips the frame, and a skipped last frame is tried again', () => {
  const clock = fakeClock(NOW)
  const lines: string[] = []
  let full = true
  let generation = 0
  const loop = new FrameLoop({
    now: clock.now,
    paint: () => new Uint8Array(4),
    write: () => (full ? undefined : { name: '/lm-test0001-0', generation: ++generation }),
    expire: () => 0,
    emit: line => lines.push(line),
    schedule: (ms, fn) => clock.schedule(ms, fn),
  })
  const board = idle()
  loop.setSetup(SETUP)
  loop.setBoard(board, NOW, changedAt(board))
  clock.run(100)
  expect(lines).toEqual([])
  expect(loop.stats().skips).toBe(1)
  full = false
  clock.run(2000)
  expect(lines.filter(l => l.startsWith('F '))).toEqual(['F /lm-test0001-0 727 680 1'])
})

test('one expire runs 1100 ms after the last frame once the map is still', () => {
  const clock = fakeClock(NOW)
  const expires: number[] = []
  const loop = new FrameLoop({
    now: clock.now,
    paint: () => new Uint8Array(4),
    write: () => ({ name: '/lm-test0001-0', generation: 1 }),
    expire: now => (expires.push(now), 2),
    emit: () => {},
    schedule: (ms, fn) => clock.schedule(ms, fn),
  })
  const board = idle()
  loop.setSetup(SETUP)
  loop.setBoard(board, NOW, changedAt(board))
  clock.run(5000)
  expect(expires.filter(at => at >= NOW + 1100)).toEqual([NOW + 1100])
  expect(loop.stats().expired).toBeGreaterThanOrEqual(2)
})

test('a paint that throws prints E and waits for the next board', () => {
  const clock = fakeClock(NOW)
  const lines: string[] = []
  let broken = true
  const loop = new FrameLoop({
    now: clock.now,
    paint: () => {
      if (broken) throw new Error('bad\nboard')
      return new Uint8Array(4)
    },
    write: () => ({ name: '/lm-test0001-0', generation: 1 }),
    expire: () => 0,
    emit: line => lines.push(line),
    schedule: (ms, fn) => clock.schedule(ms, fn),
  })
  const board = fresh()
  loop.setSetup(SETUP)
  loop.setBoard(board, NOW, changedAt(board))
  clock.run(1000)
  expect(lines).toEqual(['E paint: bad board'])
  broken = false
  loop.setBoard(board, clock.now(), changedAt(board))
  clock.run(100)
  expect(lines.filter(l => l.startsWith('F ')).length).toBeGreaterThan(0)
})

test('stats count frames and report the state', () => {
  const h = start(fresh())
  h.clock.run(1000)
  const s = h.loop.stats()
  expect(s.frames).toBe(h.frames())
  expect(s.skips).toBe(0)
  expect(s.expired).toBe(0)
  expect(typeof s.paintMs).toBe('number')
  expect(typeof s.shmMs).toBe('number')
})

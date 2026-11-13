import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameLoop } from './loop'
import type { HelperSetup, HelperStats } from './loop'
import { prepareSocket, serve } from './server'
import type { Board } from '../types'

const dirs: string[] = []
const socketIn = (name: string): { dir: string; path: string } => {
  const dir = join(tmpdir(), `lm-spec-${process.pid.toString(36)}-${name}`)
  dirs.push(dir)
  return { dir, path: join(dir, 'h.sock') }
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** A loop that only records what it was told. */
const recorder = () => {
  const got: { kind: string; value?: unknown }[] = []
  const stats: HelperStats = { state: 'still', frames: 3, skips: 1, expired: 2, paintMs: 4.5, shmMs: 0.3 }
  const loop = {
    setBoard: (board: Board, now: number, changedAt: number) => got.push({ kind: 'board', value: { board, now, changedAt } }),
    setSetup: (setup: HelperSetup) => got.push({ kind: 'setup', value: setup }),
    pause: () => got.push({ kind: 'pause' }),
    resume: () => got.push({ kind: 'resume' }),
    frame: () => got.push({ kind: 'frame' }),
    stats: () => stats,
  }
  return { got, stats, loop: loop as unknown as FrameLoop }
}

test('prepareSocket makes the directory 0700 and removes a stale socket file', () => {
  const { dir, path } = socketIn('prep')
  prepareSocket(path)
  expect(statSync(dir).isDirectory()).toBe(true)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  writeFileSync(path, 'stale')
  prepareSocket(path)
  expect(existsSync(path)).toBe(false)
})

test('prepareSocket narrows a directory it owns that others could enter', () => {
  const { dir, path } = socketIn('wide')
  mkdirSync(dir, { mode: 0o755 })
  prepareSocket(path)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
})

test('setup, board, pause, resume and frame reach the loop; stats come back as JSON', async () => {
  const { path } = socketIn('serve')
  prepareSocket(path)
  const { got, stats, loop } = recorder()
  const server = serve(path, loop)
  const post = (route: string, body?: unknown) =>
    fetch(`http://localhost${route}`, { unix: path, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  try {
    const setup: HelperSetup = { options: { coreName: 'Ada' }, light: true, rows: 20 }
    const board: Board = { entries: [{ id: 'e1', station: 'files', label: 'a.ts', from: 'core', startedAt: 10, status: 'run' }], counts: { files: 1 } }
    expect((await post('/setup', setup)).status).toBe(200)
    expect((await post('/board', { board, now: 1000, changedAt: 10 })).status).toBe(200)
    expect((await post('/pause')).status).toBe(200)
    expect((await post('/resume', {})).status).toBe(200)
    expect((await post('/frame')).status).toBe(200)
    expect(got).toEqual([
      { kind: 'setup', value: setup },
      { kind: 'board', value: { board, now: 1000, changedAt: 10 } },
      { kind: 'pause' },
      { kind: 'resume' },
      { kind: 'frame' },
    ])
    const r = await post('/stats')
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual(stats)
  } finally {
    server.stop()
  }
})

test('a malformed body gets 400 and changes nothing; anything else gets 404', async () => {
  const { path } = socketIn('bad')
  prepareSocket(path)
  const { got, loop } = recorder()
  const server = serve(path, loop)
  const send = (route: string, body?: string, method = 'POST') => fetch(`http://localhost${route}`, { unix: path, method, body })
  try {
    expect((await send('/setup', '{not json')).status).toBe(400)
    expect((await send('/setup', JSON.stringify({ options: {}, light: 'yes', rows: 20 }))).status).toBe(400)
    expect((await send('/setup', JSON.stringify({ options: {}, light: false, rows: 0 }))).status).toBe(400)
    expect((await send('/setup', JSON.stringify({ options: [], light: false, rows: 20 }))).status).toBe(400)
    expect((await send('/board', JSON.stringify({ board: { entries: 'x', counts: {} }, now: 1, changedAt: 1 }))).status).toBe(400)
    expect((await send('/board', JSON.stringify({ board: { entries: [], counts: {} }, now: 'soon', changedAt: 1 }))).status).toBe(400)
    expect((await send('/board', JSON.stringify({ board: { entries: [{ station: 'files' }], counts: {} }, now: 1, changedAt: 1 }))).status).toBe(400)
    expect((await send('/board', ''))).toHaveProperty('status', 400)
    expect((await send('/pause', 'garbage')).status).toBe(400)
    expect((await send('/frame', '[1]')).status).toBe(400)
    expect((await send('/nothing', '{}')).status).toBe(404)
    expect((await send('/stats', undefined, 'GET')).status).toBe(404)
    expect(got).toEqual([])
  } finally {
    server.stop()
  }
})

test('/frame while still sends exactly one fresh F line; while paused, none', async () => {
  const { path } = socketIn('frame')
  prepareSocket(path)
  const lines: string[] = []
  let generation = 0
  const loop = new FrameLoop({
    now: () => Date.now(),
    paint: () => new Uint8Array(4),
    write: () => ({ name: '/lm-spec0001-0', generation: ++generation }),
    expire: () => 0,
    emit: line => lines.push(line),
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  })
  const server = serve(path, loop)
  const post = (route: string, body?: unknown) =>
    fetch(`http://localhost${route}`, { unix: path, method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) })
  const frames = () => lines.filter(l => l.startsWith('F ')).length
  const settle = () => Bun.sleep(150)
  try {
    const now = Date.now()
    const board: Board = { entries: [{ id: 'e1', station: 'files', label: 'a.ts', from: 'core', startedAt: now - 200_000, endedAt: now - 199_000, status: 'ok' }], counts: { files: 1 } }
    await post('/setup', { options: {}, light: false, rows: 12 })
    await post('/board', { board, now, changedAt: now - 199_000 })
    await settle()
    expect(frames()).toBe(1)
    expect(loop.stats().state).toBe('still')
    expect((await post('/frame')).status).toBe(200)
    await settle()
    expect(frames()).toBe(2)
    expect(lines.at(-1)).toBe('F /lm-spec0001-0 436 408 2')
    await post('/pause')
    expect((await post('/frame', {})).status).toBe(200)
    await settle()
    expect(frames()).toBe(2)
  } finally {
    server.stop()
    loop.pause()
  }
})

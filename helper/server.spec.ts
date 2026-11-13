import { afterAll, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FrameLoop, HelperSetup, HelperStats } from './loop'
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

test('setup, board, pause and resume reach the loop; stats come back as JSON', async () => {
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
    expect(got).toEqual([
      { kind: 'setup', value: setup },
      { kind: 'board', value: { board, now: 1000, changedAt: 10 } },
      { kind: 'pause' },
      { kind: 'resume' },
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
    expect((await send('/nothing', '{}')).status).toBe(404)
    expect((await send('/stats', undefined, 'GET')).status).toBe(404)
    expect(got).toEqual([])
  } finally {
    server.stop()
  }
})

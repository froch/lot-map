// The plugin and the helper agree: the /setup and /board bodies the plugin builds (hooks/helper-bodies.ts, as
// register.tsx posts them) go to a real helper server and loop, which answer 200 and paint a frame whose F line the
// plugin's own reader takes.
import { afterAll, expect, test } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GOLDEN_CASES } from '../hooks/golden-cases'
import { boardBody, setupBody } from '../hooks/helper-bodies'
import { LayerCache, paintScene, pictureFor } from '../hooks/paint/scene-paint'
import { DARK } from '../hooks/palette'
import { LineReader } from '../hooks/terminal'
import type { HelperLine } from '../hooks/terminal'
import type { Board } from '../types'
import { FrameLoop } from './loop'
import { NameRing } from './ring'
import { prepareSocket, serve } from './server'
import type { Shm } from './shm'

const dir = join(tmpdir(), `lm-spec-${process.pid.toString(36)}-contract`)
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The options as the engine hands them to register: each userConfig default of the manifest. */
const manifest = JSON.parse(readFileSync(join(import.meta.dir, '..', '.claude-plugin', 'plugin.json'), 'utf8')) as {
  userConfig: Record<string, { default: unknown }>
}
const options = Object.fromEntries(Object.entries(manifest.userConfig).map(([key, field]) => [key, field.default]))

/** The helper as painter.ts builds it, with shared memory kept in a map, so nothing is left in /dev/shm. */
function helper() {
  const live = new Map<string, Uint8Array>()
  const shm: Shm = {
    put: (name, bytes) => (live.has(name) ? -17 : (live.set(name, bytes.slice()), 0)),
    drop: name => (live.delete(name) ? 0 : -2),
    read: name => live.get(name),
  }
  const ring = new NameRing('cntr0001', shm)
  const reader = new LineReader()
  const frames: Extract<HelperLine, { kind: 'F' }>[] = []
  let cache: LayerCache | undefined
  const loop = new FrameLoop({
    now: () => Date.now(),
    paint: (scene, t, picture, paintOptions) => {
      cache ??= new LayerCache(picture, paintOptions)
      return paintScene(scene, t, picture, paintOptions, cache).toStraight()
    },
    write: (bytes, now) => ring.write(bytes, now),
    expire: now => ring.expire(now),
    emit: line => {
      for (const read of reader.push(`${line}\n`)) if (read.kind === 'F') frames.push(read)
    },
    schedule: (ms, fn) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    },
  })
  return { live, frames, loop }
}

const waitFor = async (ok: () => boolean, ms = 10_000): Promise<void> => {
  const end = performance.now() + ms
  while (!ok() && performance.now() < end) await Bun.sleep(10)
}

/** The pixel at (x, y) of a frame `width` wide, as #rrggbb and its alpha. */
const pixel = (bytes: Uint8Array, width: number, x: number, y: number): string => {
  const at = (y * width + x) * 4
  return `#${[0, 1, 2, 3].map(i => bytes[at + i]!.toString(16).padStart(2, '0')).join('')}`
}

test('the setup and boards the plugin posts are taken by a real helper, which paints a frame for each', async () => {
  const path = join(dir, 'h.sock')
  prepareSocket(path)
  const { live, frames, loop } = helper()
  const server = serve(path, loop)
  const post = (route: string, body: string) => fetch(`http://localhost${route}`, { unix: path, method: 'POST', body })
  try {
    // A session's start: the empty board, which has never changed.
    const empty: Board = { entries: [], counts: {} }
    const start = boardBody(empty, Date.now())
    expect(JSON.parse(start).changedAt).toBe(0)
    const rows = 20
    const answers = [await post('/setup', setupBody(options, false, rows)), await post('/board', start)]
    expect(answers.map(a => a.status)).toEqual([200, 200])
    await waitFor(() => frames.length > 0)
    const picture = pictureFor(rows)
    const first = frames[0]!
    expect(first).toMatchObject({ kind: 'F', width: picture.width, height: picture.height })
    expect(first.name).toMatch(/^\/lm-cntr0001-[0-7]$/)
    expect(first.generation).toBeLessThan(2 ** 30)
    const still = live.get(first.name)!
    expect(still.length).toBe(picture.width * picture.height * 4)
    expect(pixel(still, picture.width, 20, 20)).toBe(`${DARK.ground}ff`) // inside the rounded ground

    // A busy board from the golden cases, posted at its own clock, then a light setup.
    const busy = GOLDEN_CASES.find(g => g.name === 'busy-default')!
    const before = frames.length
    expect((await post('/board', boardBody(busy.board, busy.now))).status).toBe(200)
    await waitFor(() => frames.length > before)
    const moving = frames.at(-1)!
    expect(moving.generation).toBeGreaterThan(first.generation)
    const painted = live.get(moving.name)!
    expect(painted.length).toBe(picture.width * picture.height * 4)
    expect(painted).not.toEqual(still)
    expect(loop.stats().state).toBe('running')

    const lightRows = 12
    expect((await post('/setup', setupBody(options, true, lightRows))).status).toBe(200)
    await waitFor(() => frames.at(-1)!.width === pictureFor(lightRows).width)
    expect(frames.at(-1)).toMatchObject({ width: pictureFor(lightRows).width, height: pictureFor(lightRows).height })
  } finally {
    loop.pause()
    server.stop()
  }
}, 30_000)

// The helper: run as `bun helper/painter.ts <socket path> <tag>`. It takes the board and setup over a Unix socket,
// paints the map into a ring of eight shared-memory names, and prints on stdout:
//   R                                      once the socket listens
//   F <name> <width> <height> <generation> after each frame is written
//   S <frames> <paint ms> <shm ms> <unread> skips=<n> expired=<n>   once a second while frames flow
//   E <message>                            on an error
// It never reads stdin (the plugin closes it from the start). It ends on SIGTERM, SIGINT, SIGHUP or SIGPIPE, on an
// error writing stdout, or when its parent is gone; then it unlinks unread names and removes its socket.
import { rmdirSync, rmSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { LayerCache, paintScene } from '../hooks/paint/scene-paint'
import { FrameLoop } from './loop'
import { NameRing } from './ring'
import { prepareSocket, serve } from './server'
import { loadShm } from './shm'
import type { Shm } from './shm'

const ORPHAN_POLL_MS = 2000

const oneLine = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim()
const note = (text: string): void => {
  try {
    process.stderr.write(`painter: ${text}\n`)
  } catch {
    // stderr gone too: nothing to tell
  }
}

/** Prints E and exits 2, before anything is running; written synchronously so it is not lost to the exit. */
function fail(message: string): never {
  try {
    writeSync(1, `E ${message}\n`)
  } catch {
    // stdout gone: the exit code says it
  }
  process.exit(2)
}

const [socketPath, tag] = process.argv.slice(2)
if (socketPath === undefined || tag === undefined || !/^[a-z0-9]{8}$/.test(tag)) {
  fail('usage: bun helper/painter.ts <socket path> <tag: 8 of [a-z0-9]>')
}

try {
  prepareSocket(socketPath)
} catch (e) {
  fail(`socket: ${oneLine(e)}`)
}

let shm: Shm
try {
  shm = loadShm()
} catch (e) {
  fail(`shm: ${oneLine(e)}`)
}

const ring = new NameRing(tag, shm)
ring.clean()

let stopping = false
const out = (line: string): void => {
  if (stopping) return
  try {
    process.stdout.write(`${line}\n`)
  } catch (e) {
    stop(`stdout: ${oneLine(e)}`)
  }
}

let cache: LayerCache | undefined
const loop = new FrameLoop({
  now: () => Date.now(),
  paint: (scene, t, picture, options) => {
    cache ??= new LayerCache(picture, options)
    return paintScene(scene, t, picture, options, cache).toStraight()
  },
  write: (bytes, now) => ring.write(bytes, now),
  expire: now => ring.expire(now),
  emit: out,
  schedule: (ms, fn) => {
    const timer = setTimeout(fn, ms)
    return () => clearTimeout(timer)
  },
  unread: () => ring.unread(),
})

let server: { stop(): void }
try {
  server = serve(socketPath, loop)
} catch (e) {
  fail(`serve: ${oneLine(e)}`)
}

const orphanPoll = setInterval(() => {
  if (process.ppid === 1) stop('parent gone')
}, ORPHAN_POLL_MS)

/** Unlinks every name of the ring (what is unread), stops the server, removes the socket and exits. */
function stop(why: string): void {
  if (stopping) return
  stopping = true
  clearInterval(orphanPoll)
  loop.pause()
  ring.clean()
  try {
    server.stop()
  } catch {
    // already closed
  }
  rmSync(socketPath!, { force: true })
  try {
    rmdirSync(dirname(socketPath!))
  } catch {
    // not empty, or already gone
  }
  note(`stopped (${why})`)
  process.exit(0)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE'] as const) process.on(signal, () => stop(signal))
process.stdout.on('error', (e: Error) => stop(`stdout: ${oneLine(e)}`))
process.on('uncaughtException', e => {
  out(`E ${oneLine(e)}`)
  stop('uncaught exception')
})
process.on('unhandledRejection', e => {
  out(`E ${oneLine(e)}`)
  stop('unhandled rejection')
})
// A last resort for any other way out: nothing of ours stays in shared memory.
process.on('exit', () => ring.clean())

out('R')

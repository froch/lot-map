// The helper's channel in: JSON over POST on a Unix socket in a private directory. It carries the board and the
// setup, never frame data.
import { chmodSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { STATIONS } from '../hooks/map'
import type { Board } from '../types'
import type { FrameLoop, HelperSetup } from './loop'

/** Makes the socket's directory, mode 0700 and ours alone, and removes a stale socket left in it. */
export function prepareSocket(path: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const st = lstatSync(dir)
  if (!st.isDirectory()) throw new Error(`${dir} is not a directory`)
  const uid = process.getuid?.()
  if (uid !== undefined && st.uid !== uid) throw new Error(`${dir} belongs to another user`)
  if ((st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700)
  rmSync(path, { force: true })
}

// ---- reading the bodies -------------------------------------------------------------------------

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const optional = (v: unknown, is: (v: unknown) => boolean): boolean => v === undefined || is(v)
const oneOf = (values: readonly string[]) => (v: unknown): boolean => typeof v === 'string' && values.includes(v)
const numbersBy = (keys: (v: unknown) => boolean) => (v: unknown): boolean =>
  isObject(v) && Object.entries(v).every(([k, n]) => keys(k) && isNumber(n))

const isStation = oneOf(STATIONS.map(s => s.id))
const isFrom = oneOf(['core', 'agents', 'inbound'])
const isStatus = oneOf(['run', 'ok', 'err', 'block'])
const isMark = oneOf(['switch', 'done'])
const isCounts = numbersBy(isStation)

const isEntry = (e: unknown): boolean =>
  isObject(e) &&
  isString(e.id) &&
  isStation(e.station) &&
  isString(e.label) &&
  isFrom(e.from) &&
  isNumber(e.startedAt) &&
  optional(e.endedAt, isNumber) &&
  isStatus(e.status) &&
  optional(e.agentId, isString) &&
  optional(e.mark, isMark)

/** The board's shape, as the scene reads it. */
const isBoard = (b: unknown): b is Board =>
  isObject(b) &&
  Array.isArray(b.entries) &&
  b.entries.every(isEntry) &&
  isCounts(b.counts) &&
  optional(b.model, isString) &&
  optional(b.step, isNumber) &&
  optional(b.pushed, isNumber) &&
  optional(b.faults, isCounts) &&
  optional(b.agents, (a: unknown) => Array.isArray(a) && a.every(isString)) &&
  optional(b.context, isNumber) &&
  optional(b.switchedAt, isNumber)

const isSetup = (s: unknown): s is HelperSetup =>
  isObject(s) && isObject(s.options) && typeof s.light === 'boolean' && Number.isInteger(s.rows) && (s.rows as number) > 0

const isBoardPost = (p: unknown): p is { board: Board; now: number; changedAt: number } =>
  isObject(p) && isBoard(p.board) && isNumber(p.now) && isNumber(p.changedAt)

/** Empty, or a JSON object. */
const isNothing = (text: string): boolean => {
  if (text.trim() === '') return true
  try {
    return isObject(JSON.parse(text))
  } catch {
    return false
  }
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ---- the server ---------------------------------------------------------------------------------

const ok = (): Response => Response.json({})
const bad = (why: string): Response => new Response(why, { status: 400 })
const notFound = (): Response => new Response('not found', { status: 404 })

/**
 * Listens on `path` and hands each request to the loop: POST /setup, /board, /pause, /resume, /frame (one fresh
 * frame now, for a remounted Image) and /stats. Anything else answers 404; a malformed body answers 400 and changes
 * nothing.
 */
export function serve(path: string, loop: FrameLoop): { stop(): void } {
  const server = Bun.serve({
    unix: path,
    async fetch(req) {
      const route = new URL(req.url).pathname
      if (req.method !== 'POST') return notFound()
      switch (route) {
        case '/setup': {
          const body = parse(await req.text())
          if (!isSetup(body)) return bad('setup: expected { options: object, light: boolean, rows: positive integer }')
          loop.setSetup({ options: body.options, light: body.light, rows: body.rows })
          return ok()
        }
        case '/board': {
          const body = parse(await req.text())
          if (!isBoardPost(body)) return bad('board: expected { board: Board, now: number, changedAt: number }')
          loop.setBoard(body.board, body.now, body.changedAt)
          return ok()
        }
        case '/pause':
        case '/resume':
        case '/frame': {
          if (!isNothing(await req.text())) return bad(`${route.slice(1)}: expected an empty body or {}`)
          if (route === '/pause') loop.pause()
          else if (route === '/resume') loop.resume()
          else loop.frame()
          return ok()
        }
        case '/stats':
          return Response.json(loop.stats())
        default:
          return notFound()
      }
    },
    error(e) {
      return new Response(`error: ${e.message}`, { status: 500 })
    },
  })
  return {
    stop: () => {
      server.stop(true)
    },
  }
}

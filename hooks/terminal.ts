// Pure decisions for showing the ring map as a terminal picture. No engine calls.

export const CELL_RATIO = 2.1
export const MIN_RING_ROWS = 12

const ASPECT = 460 / 430

export function ringBox(bodyRows: number, bodyColumns: number): { columns: number; rows: number } | undefined {
  let rows = Math.floor(bodyRows * 0.6)
  let columns = Math.round(rows * CELL_RATIO * ASPECT)
  if (columns > bodyColumns) {
    columns = bodyColumns
    rows = Math.floor(columns / (CELL_RATIO * ASPECT))
  }
  if (rows < MIN_RING_ROWS) return undefined
  return { columns, rows }
}

export type Env = Readonly<Record<string, string | undefined>>

export const ENV_NAMES = ['TERM_PROGRAM', 'TERM', 'KITTY_WINDOW_ID', 'TMUX', 'ZELLIJ', 'STY', 'SSH_CONNECTION', 'SSH_TTY', 'TMPDIR', 'HOME'] as const

export function terminalAllows(env: Env): boolean {
  const kitty = env.TERM_PROGRAM === 'ghostty' || env.TERM === 'xterm-kitty' || !!env.KITTY_WINDOW_ID
  if (!kitty) return false
  return !(env.TMUX || env.ZELLIJ || env.STY || env.SSH_CONNECTION || env.SSH_TTY)
}

export function socketPath(env: Env, tag: string): string {
  const tail = `/lot-map-${tag}/h.sock`
  const tmp = env.TMPDIR?.replace(/\/+$/, '')
  if (tmp) {
    const full = `${tmp}${tail}`
    if (new TextEncoder().encode(full).length <= 100) return full
  }
  return `/tmp${tail}`
}

export function newTag(random: () => number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let tag = ''
  for (let i = 0; i < 8; i++) tag += alphabet[Math.floor(random() * 36)]
  return tag
}

export type Refusal = { next: 'text' } | { next: 'pause' } | { next: 'carry-on' }

const ALT_PREFIX = 'the Image draws its alt here:'
const NOT_MOUNTED_PREFIX = 'no Image of its own is mounted'

/** The Image the frame was for is not mounted: hidden, closed, or not mounted yet. */
export const isNotMounted = (deny: string): boolean => deny.startsWith(NOT_MOUNTED_PREFIX)

export class PictureGate {
  private takenOne = false
  private firstAlt: number | undefined
  private switchedAt: number | undefined

  accepted(_now: number): void {
    this.takenOne = true
  }

  refused(deny: string, now: number): Refusal {
    const alt = deny.startsWith(ALT_PREFIX)
    if (isNotMounted(deny)) return { next: 'pause' }
    if (this.takenOne) return alt ? { next: 'pause' } : { next: 'carry-on' }
    if (!alt) return { next: 'carry-on' }
    if (this.firstAlt === undefined) {
      this.firstAlt = now
      return { next: 'carry-on' }
    }
    if (now - this.firstAlt >= 2000) {
      this.switchedAt = now
      return { next: 'text' }
    }
    return { next: 'carry-on' }
  }

  rendered(now: number): { reopen: boolean } {
    if (this.switchedAt !== undefined && now - this.switchedAt >= 60_000) {
      this.switchedAt = undefined
      this.firstAlt = undefined
      this.takenOne = false
      return { reopen: true }
    }
    return { reopen: false }
  }

  showsPicture(): boolean {
    return this.switchedAt === undefined
  }
}

export class HelperPolicy {
  private exits: number[] = []

  exited(now: number): { restartIn: number } | { giveUp: true } {
    this.exits = this.exits.filter(t => now - t <= 60_000)
    this.exits.push(now)
    if (this.exits.length === 1) return { restartIn: 1000 }
    if (this.exits.length === 2) return { restartIn: 5000 }
    return { giveUp: true }
  }
}

export class Coalescer<T> {
  private sentAt: number | undefined
  private pending: { value: T } | undefined

  offer(value: T, now: number): T | undefined {
    if (this.sentAt === undefined || now - this.sentAt >= 100) {
      this.sentAt = now
      this.pending = undefined
      return value
    }
    this.pending = { value }
    return undefined
  }

  due(now: number): T | undefined {
    if (this.pending && this.sentAt !== undefined && now - this.sentAt >= 100) {
      const { value } = this.pending
      this.pending = undefined
      this.sentAt = now
      return value
    }
    return undefined
  }

  waitMs(now: number): number | undefined {
    if (!this.pending || this.sentAt === undefined) return undefined
    return Math.max(0, 100 - (now - this.sentAt))
  }
}

export type HelperLine =
  | { kind: 'R' }
  | { kind: 'F'; name: string; width: number; height: number; generation: number }
  | { kind: 'S'; text: string }
  | { kind: 'E'; message: string }

const POSITIVE_INT = /^[1-9][0-9]*$/

export class LineReader {
  private rest = ''

  push(piece: string): HelperLine[] {
    this.rest += piece
    const out: HelperLine[] = []
    let nl: number
    while ((nl = this.rest.indexOf('\n')) >= 0) {
      const line = this.rest.slice(0, nl).replace(/\r/g, '')
      this.rest = this.rest.slice(nl + 1)
      const parsed = parseLine(line)
      if (parsed) out.push(parsed)
    }
    return out
  }
}

function parseLine(line: string): HelperLine | undefined {
  if (line === 'R') return { kind: 'R' }
  if (line.startsWith('F ')) {
    const f = line.slice(2).split(' ')
    if (f.length !== 4 || !f[0]!.startsWith('/')) return undefined
    if (!POSITIVE_INT.test(f[1]!) || !POSITIVE_INT.test(f[2]!) || !POSITIVE_INT.test(f[3]!)) return undefined
    return { kind: 'F', name: f[0]!, width: Number(f[1]), height: Number(f[2]), generation: Number(f[3]) }
  }
  if (line.startsWith('S ') && line.length > 2) return { kind: 'S', text: line.slice(2) }
  if (line.startsWith('E ') && line.length > 2) return { kind: 'E', message: line.slice(2) }
  return undefined
}

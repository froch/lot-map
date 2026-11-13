// The frames' names: a ring of `size` fixed names per session tag, each frame numbered by a running generation.
// The terminal reads a name and unlinks it; until then the name is unread and cannot be written again.
// The generation is the freshness marker of a reused name, so it starts at the clock when the helper starts: a
// restarted helper with the same tag never repeats a (name, generation) pair of its predecessor. The clock is taken
// modulo 10^9, so a generation stays a small whole number (below 2^30) that any terminal path holds exactly.
import type { Shm } from './shm'

const EEXIST = 17
/** A frame still unread this long after it was written is unlinked by `expire`. */
export const EXPIRE_MS = 1000
/** The clock's milliseconds are taken modulo this for the first generation: below 2^30, about 11.6 days round. */
export const GENERATION_SPAN = 1_000_000_000

/** The first generation of a helper starting at `now`: the clock modulo GENERATION_SPAN, never 0 (the plugin drops an F line whose generation is not positive). */
export const firstGeneration = (now: number): number => now % GENERATION_SPAN || 1

export class NameRing {
  private readonly names: string[]
  /** When each name was last written, while it may still be unread. */
  private readonly writtenAt: (number | undefined)[]
  private next = 0
  /** The next frame's generation. */
  private generation: number

  constructor(
    readonly tag: string,
    private readonly shm: Shm,
    readonly size = 8,
    first = firstGeneration(Date.now()),
  ) {
    this.names = Array.from({ length: size }, (_, k) => `/lm-${tag}-${k}`)
    this.writtenAt = this.names.map(() => undefined)
    this.generation = first
  }

  /** Unlinks every name of the ring, read or not: a predecessor's leftovers at start, what is unread at exit. */
  clean(): void {
    for (const [k, name] of this.names.entries()) {
      this.shm.drop(name)
      this.writtenAt[k] = undefined
    }
  }

  /**
   * Writes a frame to the first name, from the next one round, that the terminal has read, numbered with the next
   * generation. Undefined when all are unread: backpressure, so the frame is skipped. Throws on any other failure.
   */
  write(bytes: Uint8Array, now: number): { name: string; generation: number } | undefined {
    for (let i = 0; i < this.size; i++) {
      const k = (this.next + i) % this.size
      const name = this.names[k]!
      const r = this.shm.put(name, bytes)
      if (r === -EEXIST) continue
      if (r !== 0) throw new Error(`shm_put ${name}: errno ${-r}`)
      this.next = (k + 1) % this.size
      this.writtenAt[k] = now
      return { name, generation: this.generation++ }
    }
    return undefined
  }

  /** Unlinks names written more than EXPIRE_MS before `now` that are still unread; how many it unlinked. */
  expire(now: number): number {
    let dropped = 0
    for (const [k, at] of this.writtenAt.entries()) {
      if (at === undefined || now - at <= EXPIRE_MS) continue
      if (this.shm.drop(this.names[k]!) === 0) dropped++
      this.writtenAt[k] = undefined
    }
    return dropped
  }

  /** How many written names are still unread, by probing each without copying it. */
  unread(): number {
    let count = 0
    for (const [k, at] of this.writtenAt.entries()) {
      if (at === undefined) continue
      if (this.shm.read(this.names[k]!, 0) !== undefined) count++
      else this.writtenAt[k] = undefined
    }
    return count
  }
}

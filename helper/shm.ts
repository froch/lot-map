// POSIX shared memory for the helper: the C shim in shm.c, compiled with bun:ffi's `cc` when first loaded.
import { cc } from 'bun:ffi'

/** Shared-memory objects by name. `put` and `drop` return 0 or -errno; `put` gives -EEXIST (-17) while the name is unread. */
export type Shm = {
  put(name: string, bytes: Uint8Array): number
  drop(name: string): number
  /** The first `length` bytes of `name`, or undefined when it cannot be read; for tests, the feed reader and probes (length 0). */
  read(name: string, length: number): Uint8Array | undefined
}

const encoder = new TextEncoder()
/** NUL-terminated names, kept: the ring reuses its eight names for every frame. */
const cNames = new Map<string, Uint8Array>()
const cName = (name: string): Uint8Array => {
  let c = cNames.get(name)
  if (c === undefined) {
    c = encoder.encode(`${name}\0`)
    if (cNames.size < 256) cNames.set(name, c)
  }
  return c
}

let loaded: Shm | undefined

/** Compiles the shim (once per process) and returns its calls. Throws when `cc` fails. */
export function loadShm(): Shm {
  if (loaded !== undefined) return loaded
  const { symbols } = cc({
    source: `${import.meta.dir}/shm.c`,
    symbols: {
      shm_put: { args: ['ptr', 'ptr', 'u64'], returns: 'i32' },
      shm_drop: { args: ['ptr'], returns: 'i32' },
      shm_read: { args: ['ptr', 'ptr', 'u64'], returns: 'i32' },
    },
  })
  const empty = new Uint8Array(1)
  loaded = {
    put: (name, bytes) => symbols.shm_put(cName(name), bytes.length > 0 ? bytes : empty, bytes.length),
    drop: name => symbols.shm_drop(cName(name)),
    read: (name, length) => {
      const out = new Uint8Array(length)
      return symbols.shm_read(cName(name), length > 0 ? out : empty, length) === 0 ? out : undefined
    },
  }
  return loaded
}

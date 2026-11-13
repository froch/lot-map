import { afterAll, expect, test } from 'bun:test'
import { loadShm } from './shm'

const shm = loadShm()
const name = `/lmspec-${process.pid.toString(36)}-${Date.now().toString(36).slice(-5)}`

afterAll(() => {
  shm.drop(name)
})

test('a frame put under a name reads back the same bytes, a second put is refused, and a dropped name is gone', () => {
  const bytes = new Uint8Array(727 * 680 * 4)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 255
  expect(shm.put(name, bytes)).toBe(0)
  const back = shm.read(name, bytes.length)
  expect(back).toBeDefined()
  expect(Buffer.from(back!).equals(Buffer.from(bytes))).toBe(true)
  expect(shm.put(name, bytes)).toBe(-17)
  expect(shm.drop(name)).toBe(0)
  expect(shm.read(name, bytes.length)).toBeUndefined()
  expect(shm.drop(name)).toBe(-2)
})

test('read with length 0 tells whether a name exists without copying', () => {
  expect(shm.put(name, new Uint8Array([1, 2, 3, 4]))).toBe(0)
  expect(shm.read(name, 0)?.length).toBe(0)
  expect(shm.drop(name)).toBe(0)
  expect(shm.read(name, 0)).toBeUndefined()
})

test('read refuses a length beyond the object', () => {
  expect(shm.put(name, new Uint8Array(16))).toBe(0)
  expect(shm.read(name, 1 << 20)).toBeUndefined()
  expect(shm.drop(name)).toBe(0)
})

// The helper as the plugin runs it: a bun process with stdin closed, read line by line from stdout.
import { expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('the helper prints R, then H about once a second while still, and POST /quit ends it cleanly', async () => {
  const dir = join(tmpdir(), `lm-spec-${process.pid.toString(36)}-painter`)
  const socket = join(dir, 'h.sock')
  const tag = `spec${process.pid.toString(36).slice(-4).padStart(4, '0')}`
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'painter.ts'), socket, tag], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const lines: { line: string; at: number }[] = []
  const reading = (async () => {
    const decoder = new TextDecoder()
    let rest = ''
    for await (const piece of child.stdout) {
      rest += decoder.decode(piece, { stream: true })
      let nl: number
      while ((nl = rest.indexOf('\n')) >= 0) {
        lines.push({ line: rest.slice(0, nl), at: performance.now() })
        rest = rest.slice(nl + 1)
      }
    }
  })()
  const waitFor = async (ok: () => boolean, ms: number): Promise<void> => {
    const end = performance.now() + ms
    while (!ok() && performance.now() < end) await Bun.sleep(10)
  }
  try {
    await waitFor(() => lines.length > 0, 10_000)
    expect(lines[0]?.line).toBe('R')
    const ready = lines[0]!.at
    await Bun.sleep(3300)
    const beats = lines.filter(l => l.line === 'H').map(l => l.at - ready)
    expect(beats.length).toBe(3)
    beats.forEach((at, i) => expect(Math.abs(at - (i + 1) * 1000)).toBeLessThan(250))
    expect(lines.filter(l => l.line !== 'R' && l.line !== 'H')).toEqual([])

    const answer = await fetch('http://localhost/quit', { unix: socket, method: 'POST', body: '{}' })
    expect(answer.status).toBe(200)
    expect(await child.exited).toBe(0)
    await reading
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(dir)).toBe(false)
  } finally {
    child.kill()
  }
}, 20_000)

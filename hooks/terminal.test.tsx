import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { Coalescer, HelperPolicy, LineReader, PictureGate, newTag, ringBox, socketPath, terminalAllows } from './terminal'

const ALT = 'the Image draws its alt here: this terminal draws no images'

test('the ring box follows the pane and gives way to text below twelve rows', () => {
  expect(ringBox(34, 89)).toEqual({ columns: 45, rows: 20 })
  expect(ringBox(20, 89)).toEqual({ columns: 27, rows: 12 })
  expect(ringBox(19, 89)).toBeUndefined()
  expect(ringBox(100, 60)).toEqual({ columns: 60, rows: 26 })
  expect(ringBox(34, 40)).toEqual({ columns: 40, rows: 17 })
  expect(ringBox(34, 26)).toBeUndefined()
})

test('only Ghostty or kitty, outside tmux, zellij, screen and ssh, get a picture', () => {
  expect(terminalAllows({ TERM_PROGRAM: 'ghostty' })).toBe(true)
  expect(terminalAllows({ TERM: 'xterm-kitty' })).toBe(true)
  expect(terminalAllows({ KITTY_WINDOW_ID: '1' })).toBe(true)
  for (const env of [{ TERM_PROGRAM: 'iTerm.app' }, { TERM_PROGRAM: 'vscode' }, { TERM_PROGRAM: 'Apple_Terminal' }, {}]) expect(terminalAllows(env)).toBe(false)
  for (const extra of [{ TMUX: '/x' }, { ZELLIJ: '0' }, { STY: '1.x' }, { SSH_CONNECTION: 'a' }, { SSH_TTY: '/dev/ttys1' }]) expect(terminalAllows({ TERM_PROGRAM: 'ghostty', ...extra })).toBe(false)
})

test('the socket path stays under 100 bytes, in TMPDIR when it fits and /tmp otherwise', () => {
  expect(socketPath({ TMPDIR: '/var/folders/ab/cdefgh/T/' }, 'abcd1234')).toBe('/var/folders/ab/cdefgh/T/lot-map-abcd1234/h.sock')
  expect(socketPath({ TMPDIR: `/${'x'.repeat(90)}` }, 'abcd1234')).toBe('/tmp/lot-map-abcd1234/h.sock')
  expect(socketPath({}, 'abcd1234')).toBe('/tmp/lot-map-abcd1234/h.sock')
  expect(newTag(() => 0.5)).toMatch(/^[a-z0-9]{8}$/)
})

test('two alt refusals two seconds apart switch to text; a render a minute later reopens', () => {
  const g = new PictureGate()
  expect(g.rendered(0)).toEqual({ reopen: false })
  expect(g.refused(ALT, 100)).toEqual({ next: 'carry-on' })
  expect(g.refused(ALT, 1100)).toEqual({ next: 'carry-on' })
  expect(g.refused(ALT, 2200)).toEqual({ next: 'text' })
  expect(g.showsPicture()).toBe(false)
  expect(g.rendered(30_000)).toEqual({ reopen: false })
  expect(g.showsPicture()).toBe(false)
  expect(g.rendered(62_300)).toEqual({ reopen: true })
  expect(g.showsPicture()).toBe(true)
})

test('after a taken frame, alt and not-mounted refusals pause; the start-up message and others carry on', () => {
  const g = new PictureGate()
  g.accepted(0)
  expect(g.refused(ALT, 10)).toEqual({ next: 'pause' })
  expect(g.refused('no Image of its own is mounted under key map', 20)).toEqual({ next: 'pause' })
  expect(g.refused('the terminal has not yet said whether it reads files on this machine; asked now, blit again', 30)).toEqual({ next: 'carry-on' })
  expect(g.refused('too many blits this second', 40)).toEqual({ next: 'carry-on' })
  expect(g.showsPicture()).toBe(true)
})

test('a helper that keeps dying is restarted twice, then given up on', () => {
  const p = new HelperPolicy()
  expect([p.exited(0), p.exited(2000), p.exited(9000)]).toEqual([{ restartIn: 1000 }, { restartIn: 5000 }, { giveUp: true }])
  const q = new HelperPolicy()
  expect([q.exited(0), q.exited(70_000)]).toEqual([{ restartIn: 1000 }, { restartIn: 1000 }])
})

test('board posts are at most ten a second, the newest winning, and say when the next is due', () => {
  const c = new Coalescer<number>()
  expect(c.offer(1, 0)).toBe(1)
  expect(c.offer(2, 30)).toBeUndefined()
  expect(c.offer(3, 60)).toBeUndefined()
  expect(c.waitMs(60)).toBe(40)
  expect(c.due(90)).toBeUndefined()
  expect(c.due(100)).toBe(3)
  expect(c.due(150)).toBeUndefined()
  expect(c.waitMs(150)).toBeUndefined()
})

test('helper lines are read across pieces and malformed ones are dropped', () => {
  const r = new LineReader()
  expect(r.push('R\nF /lm-abcd1234-0 72')).toEqual([{ kind: 'R' }])
  expect(r.push('7 680 41\nS 20 6.6 0.3 0\nnonsense\nF bad\nE no cc\n')).toEqual([
    { kind: 'F', name: '/lm-abcd1234-0', width: 727, height: 680, generation: 41 },
    { kind: 'S', text: '20 6.6 0.3 0' },
    { kind: 'E', message: 'no cc' },
  ])
})

// ---- Task 12: the pane wired to the helper --------------------------------------------------------

const SLOW = { timeoutMs: 30000 }
const DOCK = { title: 'Map', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} } as const
const PANE = { plugin: 'lot-map', component: 'Pane', requestId: 'lot-map', props: DOCK } as const
const GHOSTTY = { TERM_PROGRAM: 'ghostty', TMPDIR: '/var/folders/ab/cdefgh/T/', HOME: '/Users/x' }
const path = (p: { url: string }) => new URL(p.url).pathname

type Clock = ReturnType<typeof mock.clock>
type Spawn = (clock: Clock) => AsyncGenerator<{ stream: 'stdout'; text: string }, { value: { code: number | null; signal: string | null } }>

/** A world with a fake helper that prints R, then F lines when told to, and H every second of the mock clock, as the real one does. */
const world = (
  on: On,
  opts: { env?: Record<string, string>; blit?: (n: number) => { deny?: string }; bun?: boolean; fetchOk?: boolean; status?: (path: string, n: number) => number; spawn?: Spawn; theme?: { value: string } } = {},
) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, opts.env ?? GHOSTTY)
  const spawned: string[][] = []
  const spawnedAt: number[] = []
  const runs: string[][] = []
  const posts: { url: string; body: unknown }[] = []
  const asked = new Map<string, number>()
  const blits: { name: string; generation: number; at: number }[] = []
  const toasts: string[] = []
  let stopped = 0
  let feed: (line: string) => void = () => {}
  const standard: Spawn = async function* (time) {
    const lines: string[] = ['R\n']
    let wake: (() => void) | undefined
    let isAlive = true
    const push = (line: string) => { lines.push(line); wake?.() }
    feed = push
    void (async () => { while (isAlive) { await time.sleep(1000); if (isAlive) push('H\n') } })()
    try {
      while (true) {
        while (lines.length > 0) yield { stream: 'stdout', text: lines.shift()! }
        await new Promise<void>(r => { wake = r })
      }
    } finally { isAlive = false; stopped++ }
  }
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    if (e.argv[0] === 'pkill') return { value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    return opts.bun === false ? { deny: 'not found' } : { value: { exitCode: 0, stdout: '1.4.4\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.exists', () => ({ value: opts.bun !== false }))
  on('process.spawn', async function* (_, e) { spawned.push([...e.argv]); spawnedAt.push(clock.now()); return yield* (opts.spawn ?? standard)(clock) })
  on('http.fetch', (_, e) => {
    posts.push({ url: e.url, body: JSON.parse(String(e.init?.body ?? 'null')) })
    const route = path(e)
    asked.set(route, (asked.get(route) ?? 0) + 1)
    const status = opts.status?.(route, asked.get(route)!) ?? 200
    return opts.fetchOk === false ? { deny: 'refused by policy' } : { value: { status, ok: status < 400, headers: {}, text: status < 400 ? '{}' : 'helper trouble' } }
  })
  on('ui.toast', (_, e) => { toasts.push(e.text); return { value: undefined } })
  on('ui.blit', (_, e) => { const s = ('source' in e ? e.source : {}) as { shm: string; generation: number }; blits.push({ name: s.shm, generation: s.generation, at: clock.now() }); return { value: opts.blit?.(blits.length) ?? {} } })
  on('config.list', () => ({ value: opts.theme === undefined ? [] : [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme.value, provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }))
  on('config.set', (_, e) => { if (opts.theme !== undefined) opts.theme.value = String(e.value); return { value: e.value } })
  on('tool.call', () => ({ result: {} }))
  return { clock, spawned, spawnedAt, runs, posts, blits, toasts, stopped: () => stopped, frame: (k: number) => feed(`F /lm-abcd1234-${k % 8} 727 680 ${k + 1}\n`) }
}

test('in Ghostty the pane starts one helper, posts setup and board, and relays frames with their generation', SLOW, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  expect(w.spawned.length).toBe(1)
  const tag = w.spawned[0]!.at(-1)!
  expect(w.spawned[0]!.at(-2)).toBe(`/var/folders/ab/cdefgh/T/lot-map-${tag}/h.sock`)
  expect(w.posts.map(path)).toEqual(['/setup', '/board'])
  expect(((await ui.find({ type: 'Image' }))!.props.source as { width: number }).width).toBe(1)
  w.frame(0); w.frame(1)
  await w.clock.settle()
  expect(w.blits.map(b => [b.name, b.generation])).toEqual([['/lm-abcd1234-0', 1], ['/lm-abcd1234-1', 2]])
  await ui.redraw()
  const image = await ui.find({ type: 'Image' })
  expect(image?.props).toMatchObject({ key: 'map', columns: 45, rows: 20, source: { shm: '/lm-abcd1234-1', width: 727, height: 680 } })
})

test('iTerm2 starts no helper and shows no picture', SLOW, async ($, on) => {
  const w = world(on, { env: { TERM_PROGRAM: 'iTerm.app' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(w.spawned.length).toBe(0)
})

test('tmux starts no helper and shows no picture', SLOW, async ($, on) => {
  const w = world(on, { env: { ...GHOSTTY, TMUX: '/tmp/t' } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(w.spawned.length).toBe(0)
})

test('an inline pane, a short pane and a machine without bun show the text view', SLOW, async ($, on) => {
  const w = world(on, { bun: false })
  for (const props of [{ ...DOCK, placement: 'inline' }, { ...DOCK, scroll: { offset: 0, bodyRows: 19 } }, DOCK]) {
    const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal' } as never)
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  }
  expect(w.spawned.length).toBe(0)
})

test('with terminal set to text the pane draws todays text view', { ...SLOW, options: { terminal: 'text' } }, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(w.spawned.length).toBe(0)
})

test('the feed is cut to fit under the picture, every row one line long', SLOW, async ($, on) => {
  world(on)
  for (let k = 0; k < 20; k++) {
    if (k % 2 === 0) await $.tool.call({ tool: 'Read', file_path: `/a/${k}/${'p'.repeat(120)}.ts` })
    else await $.tool.call({ tool: 'Bash', command: 'true', description: `${k} ${'x'.repeat(200)}` })
  }
  for (const [bodyRows, rows] of [[34, 20], [20, 12], [60, 36]] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...DOCK, scroll: { offset: 0, bodyRows } }, surface: 'terminal' })
    const texts = await ui.findAll({ type: 'Text' })
    for (const t of texts) expect(t.props.wrap).toBe('truncate-end')
    expect(texts.length).toBe(Math.min(bodyRows - rows, 1 + 16))
    await ui.unmount()
  }
})

test('two alt refusals two seconds apart stop the helper and show text by themselves', SLOW, async ($, on) => {
  const w = world(on, { blit: () => ({ deny: 'the Image draws its alt here: no images' }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  w.frame(0)
  await w.clock.advance(2100)
  w.frame(1)
  await w.clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await w.clock.advance(1000) // the helper's next H: its loop sees the run has ended
  expect(w.stopped()).toBe(1)
})

test('a not-mounted refusal pauses the helper, and the next render resumes it', SLOW, async ($, on) => {
  const w = world(on, { blit: n => (n === 2 ? { deny: 'no Image of its own is mounted under key map' } : {}) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  w.frame(0); w.frame(1)
  await w.clock.settle()
  expect(w.posts.map(path)).toContain('/pause')
  await ui.redraw()
  expect(w.posts.map(path).at(-1)).toBe('/resume')
})

test('board posts are coalesced to at most ten a second and the newest board arrives', SLOW, async ($, on) => {
  const w = world(on)
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  for (let k = 0; k < 10; k++) await $.tool.call({ tool: 'Read', file_path: `/a/b${k}.ts` })
  await w.clock.advance(1000)
  const boards = w.posts.filter(p => path(p) === '/board')
  expect(boards.length).toBeLessThanOrEqual(1 + 10)
  expect(JSON.stringify(boards.at(-1)!.body)).toContain('b9.ts')
})

test('a helper that exits three times within a minute leaves the text view, and an E line counts as a failure', SLOW, async ($, on) => {
  let starts = 0
  const w = world(on, { spawn: async function* () { starts++; yield { stream: 'stdout' as const, text: starts === 1 ? 'E no cc\n' : 'S x\n' }; return { value: { code: 2, signal: null } } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.advance(10_000)
  expect(starts).toBe(3)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

test('a refused socket request is a helper failure: three within a minute give the text view and one toast', SLOW, async ($, on) => {
  const w = world(on, { fetchOk: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeDefined() // one failure: a fresh helper comes in a second
  await w.clock.advance(10_000)
  expect(w.spawned.length).toBe(3)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(w.toasts.length).toBe(1)
  expect(w.toasts[0]).toContain('/setup')
  expect(w.stopped()).toBe(3)
})

test('with Claude Code on a light theme and the map on auto, setup says light; a theme change posts setup again', SLOW, async ($, on) => {
  const w = world(on, { theme: { value: 'light-daltonized' } })
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  const setups = () => w.posts.filter(p => path(p) === '/setup').map(p => (p.body as { light: boolean }).light)
  expect(setups()).toEqual([true])
  await $.config.set({ key: 'theme', value: 'dark', previous: 'light-daltonized', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })
  await w.clock.settle()
  expect(setups()).toEqual([true, false])
})

test('/lot-map stats names the mode and the frames', SLOW, async ($, on) => {
  const w = world(on)
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  w.frame(0)
  await w.clock.settle()
  const out = await $.command.run({ command: 'lot-map', args: 'stats', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } })
  expect(out.text).toMatch(/^mode: picture/)
  expect(out.text).toMatch(/frames: 1 taken · 0 refused/)
})

test('desktop still gets the Svg and no helper is started for it', SLOW, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(w.spawned.length).toBe(0)
})

test('a pane shown again while the map is still asks the helper for a fresh frame, and only then', SLOW, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  w.frame(0)
  await w.clock.settle()
  await ui.unmount()
  await w.clock.advance(100)
  let again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(w.posts.map(path)).toEqual(['/setup', '/board'])
  await again.unmount()
  await w.clock.advance(300)
  again = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(w.posts.map(path)).toEqual(['/setup', '/board', '/frame'])
  w.frame(1)
  await w.clock.settle()
  await again.redraw()
  expect((await again.find({ type: 'Image' }))?.props.source).toEqual({ shm: '/lm-abcd1234-1', format: 'rgba', width: 727, height: 680, generation: 2 })
  expect(w.spawned.length).toBe(1)
})

test('the session keeps the helper tag in $.state, and the helper is started with it', SLOW, async ($, on) => {
  const w = world(on)
  const written: unknown[] = []
  on('state.set', (_, e, next) => {
    if (e.key === 'tag') written.push(e.value)
    return next(e)
  })
  on('command.register', () => ({ value: { command: 'lot-map' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(written.length).toBe(1)
  expect(written[0]).toMatch(/^[a-z0-9]{8}$/)
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  expect(w.spawned[0]!.at(-1)).toBe(written[0] as string)
})

test('a tag kept from before a reload names the next helper', SLOW, async ($, on) => {
  const w = world(on)
  on('state.get', (_, e, next) => (e.key === 'tag' ? { value: { value: 'kept0tag', version: 1 } } : next(e)))
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  expect(w.spawned[0]!.slice(-2)).toEqual(['/var/folders/ab/cdefgh/T/lot-map-kept0tag/h.sock', 'kept0tag'])
})

test('a /board answered 500 stops the run, asks it to quit, and starts a fresh helper a second later', SLOW, async ($, on) => {
  const w = world(on, { status: (route, n) => (route === '/board' && n === 1 ? 500 : 200) })
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  const socket = w.spawned[0]!.at(-2)!
  expect(w.posts.map(path)).toEqual(['/setup', '/board', '/quit'])
  await w.clock.advance(1000)
  expect(w.spawnedAt).toEqual([1_000_000, 1_001_000])
  expect(w.stopped()).toBe(1)
  expect(w.runs.filter(argv => argv[0] === 'pkill')).toContainEqual(['pkill', '-TERM', '-f', socket])
  expect(w.runs.filter(argv => argv[0] === 'pkill').length).toBe(2) // before each spawn; the first run had ended, so no backstop
  expect(w.posts.map(path).slice(3)).toEqual(['/setup', '/board'])
})

test('a helper that never prints R is stopped after 5 s, killed a second later, and a fresh one started', SLOW, async ($, on) => {
  const w = world(on, { spawn: async function* (time) { await time.sleep(600_000); return { value: { code: 0, signal: null } } } })
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.advance(4999)
  expect(w.spawned.length).toBe(1)
  expect(w.posts).toEqual([])
  await w.clock.advance(1)
  expect(w.posts.map(path)).toEqual(['/quit'])
  await w.clock.advance(1000)
  expect(w.spawned.length).toBe(2)
  expect(w.spawnedAt).toEqual([1_000_000, 1_006_000])
  expect(w.runs.filter(argv => argv[0] === 'pkill').length).toBe(3) // before each spawn, and the backstop for the silent one
})

test('a still map switched to text by the gate ends its helper by the next H, and a reopen a minute later leaves one helper alive', SLOW, async ($, on) => {
  const w = world(on, { blit: () => ({ deny: 'the Image draws its alt here: no images' }) })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  w.frame(0)
  await w.clock.advance(2100)
  w.frame(1)
  await w.clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(w.posts.map(path).at(-1)).toBe('/quit')
  await w.clock.advance(1000)
  expect(w.stopped()).toBe(1)
  await w.clock.advance(60_000)
  await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect(w.spawned.length).toBe(2)
  expect(w.spawned.length - w.stopped()).toBe(1)
  expect(w.runs.filter(argv => argv[0] === 'pkill').length).toBe(2)
})

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

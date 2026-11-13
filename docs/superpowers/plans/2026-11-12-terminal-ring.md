# The Map in the Terminal: Implementation Plan (revision 2.1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw lot-map's ring as a smoothly moving picture in the docked terminal pane on Ghostty or kitty. A bun helper paints frames into POSIX shared memory and the pane shows each by name. The desktop SVG stays byte-identical, and every other terminal falls back to today's text view.

**Architecture:**
- `drawMap` is split into a scene that keeps today's exact SVG strings, plus two painters. `toSvg` serves desktop. The pixel painter samples each element's SMIL animations at a moment, with per-group cached layers.
- A helper process (`helper/painter.ts`, under bun) owns the frame loop at 20/15/0/1 fps. It writes frames into a ring of shared-memory names through a C shim compiled with `bun:ffi` `cc`, prints each name on stdout, and takes the board over a Unix socket.
- The plugin decides picture mode from the environment, starts and feeds the helper, relays names to `$.ui.blit`, and draws the pane.

**Tech Stack:** TypeScript hooks module for Claude Code 2.1.322+ (no DOM, no Node in hooks); bun 1.4+ for the helper and development scripts; tests with `claude-code/testing` under `claude plugin test .` and `bun test helper`.

**Spec:** `docs/superpowers/specs/2026-11-12-terminal-ring-design.md` (revision 2). Read it before any task. Its Constraints section explains every number below.

## Global Constraints

- **Desktop output.** Desktop, VS Code and mobile output of `drawMap` stays byte-identical to `main` at 2b48eb0.
- **Frames.** Frames never touch the disk; they go to shared memory only. The helper writes no files except its socket. The board goes to the helper over the Unix socket only.
- **`$` rules.** Every engine call is spelled `$.noun.method(...)` inside a hook or a closure in it; `$` is never stored, passed or returned.
- **Failures stay contained.** A failure in drawing, the helper or the relay never reaches a tool call, a turn or the conversation. Wrap it as `register.tsx`'s `quietly` does. Any such failure draws the text view.
- **Picture size.** `pictureFor(rows)`: height = `clamp(rows × 34, 408, 1000)`, width = `round(height × 460 / 430)`, scale = `height / 430`. R = 20 gives 727×680. Frames are `{ shm: name, format: 'rgba', width, height }`.
- **Rates.**
  - 20 fps while a `fast` animation changes; 15 fps while only `slow` ones change; 0 when nothing changes.
  - 1 fps once `t − changedAt ≥ 300 000` ms, where `changedAt` is the latest `startedAt`, `endedAt` or `switchedAt` on the board.
- **Ring box.**
  - `R = floor(bodyRows × 0.6)`, `C = round(R × 2.1 × 460/430)`;
  - if `C > bodyColumns` then `C = bodyColumns` and `R = floor(C / (2.1 × 460/430))`;
  - text view when `R < 12` or the placement is `inline`.
- **Picture mode, all of:**
  - option `terminal` is `picture` (the default in this branch);
  - `TERM_PROGRAM` is `ghostty`, or `TERM` is `xterm-kitty`, or `KITTY_WINDOW_ID` is set;
  - none of `TMUX`, `ZELLIJ`, `STY`, `SSH_CONNECTION`, `SSH_TTY` is set;
  - the surface is the terminal, the placement is `dock`, a ring box exists, and `bun` is found (on PATH, else `~/.bun/bin/bun`).
- **Text below the picture.** Every Text has `wrap="truncate-end"`. The tree never exceeds `bodyRows` rows.
- **Refusal prefixes:**
  - alt: `the Image draws its alt here:`;
  - not mounted: `no Image of its own is mounted`;
  - start-up capability: `the terminal has not yet said whether it reads files on this machine`.
- **Helper protocol.**
  - **Socket:** `<dir>/lot-map-<tag>/h.sock`, where `<dir>` is `TMPDIR` unless the path would exceed 100 bytes, then `/tmp`. The directory is mode 0700.
  - **Stdout lines:** `R`, `F <name> <width> <height> <generation>`, `S <text>` (only while frames flow), `E <message>`.
  - **Requests:** POST `/setup`, `/board`, `/pause`, `/resume`, `/stats`.
  - **Shared-memory names:** `/lm-<tag>-<k>`, k 0–7, where the tag is 8 characters of `[a-z0-9]` kept in `$.state`. Every frame carries a `generation` (the helper's frame counter), the ImageSource field for a reused name.
  - **Parent death.** The helper never watches stdin (`$.process.spawn` closes it from the start). It ends on SIGTERM, SIGINT, SIGHUP or SIGPIPE, on an error writing stdout, or when a 2 s poll finds `process.ppid === 1`.
- **Budgets,** measured by `bun scripts/bench.ts`: under bun, after 10 warm-up frames, on the real busy map at `pictureFor(20)`. They are never tested inside `claude plugin test`, whose runtime is several times slower.
  - a frame with no board change ≤ 7 ms on average;
  - the first frame after a one-station change ≤ 20 ms;
  - in the pane, Claude Code ≤ ~5% of a core while animating.
- **Tests.**
  - The kit's `expect` has no `toBeCloseTo`; each file defines `const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)`.
  - A test file whose import is missing fails as one `(fail) … did not load`.
  - Helper specs are `helper/*.spec.ts`, run with `bun test helper`; `claude plugin test` runs only `*.test.ts(x)`.
  - Plugin tests that paint whole pictures, or that run a fake helper, set `{ timeoutMs: 30000 }`; the default is 5000. Pictures in plugin tests are compared with `===` on `toBase64()`, never fingerprinted in bulk.
- **Pixel convention.** Pixel (x, y) covers [x, x+1) × [y, y+1) and is sampled at its centre. Storage is premultiplied 8-bit; colours are exact only at alpha 255.
- **Version 0.4.0.**

## Review Focus

1. **A core name outside the font** (emoji, CJK, `<&"`) draws hollow boxes, never throws, and leaves desktop unchanged. Tests in Task 2 (done) and Task 8.
2. **A 200-character label** cuts to one row and never pushes the picture out of the pane. Test in Task 12.
3. **Pane sizes at the edges** (a narrow dock, 19 and 20 body rows, a very tall pane) give the text view or a picture whose box and pixel size follow the formulas. Tests in Task 10 and Task 12.
4. **A subagent that never reported back** slows the helper to 1 fps after five minutes without a board change. Test in Task 9.
5. **The helper failing in any way** (no `bun`, the shim not compiling, the socket refused, three exits in a minute, killed mid-frame) gives the text view and leaves no `/lm-…` names behind in the same session. Tests in Task 11 and Task 12.

---

## Done before this revision

- **Task 1, the rasteriser** (commits 68b91a5..8bd1a3e): `hooks/paint/canvas.ts`, `hooks/paint/path.ts`.
- **Task 2, the fonts and text** (8bd1a3e..edfafa6): `hooks/paint/font.ts`, `hooks/paint/text.ts`, `scripts/font/*`.
- **Task 3, the font chosen** (edfafa6..b47f329): `hooks/paint/font-data.ts`, which exports `FONT` (JetBrains Mono) and `TEXT_SCALE = 1`.
- **Task 4, the measurements and spike:** timers from a render hook's `$` run; byte frames were rejected (iTerm2 leaks, Ghostty lags); shared memory was measured in Ghostty at 20 and 30 fps. These are recorded in the spec. The spike's helper (`ring-test/helper/painter.ts`, `helper/shm.c`) is the reference for Task 11.

### Task 5: Golden capture of the desktop drawing

**Files:**
- Create: `hooks/golden-cases.ts`, `hooks/golden-hashes.ts` (generated), `scripts/golden.ts`, `hooks/golden.test.ts`
- Modify: `.gitignore` (add `scripts/golden-out/`)

**Interfaces:**
- Consumes: `drawMap`, `setupFrom` from `./map` (Task 6 moves `drawMap` to `./svg`).
- Produces:
  - `type GoldenCase = { name: string; board: Board; now: number; options: Record<string, unknown> }`;
  - `GOLDEN_CASES: GoldenCase[]`;
  - `fingerprint(text: string): string`: 64-bit FNV-1a as 16 hex digits;
  - `GOLDEN: Readonly<Record<string, string>>`, case name to fingerprint.
- `bun scripts/golden.ts write` writes `scripts/golden-out/<n>-<name>.svg` (`n` is the case's index, so names may hold any character) and `hooks/golden-hashes.ts`. `bun scripts/golden.ts check` re-renders every case and prints, for each mismatch, the case name, the first differing offset and 80 characters either side, then `<k> mismatches`.

- [ ] **Step 1: Build exactly 68 `GOLDEN_CASES`** with fixed ids and absolute times:
  - **`busy-default` (1):** default options. Its board has a pulse in flight, a returning pulse, a beam, a running call, a fault and a route of 7 stops.
  - **Thresholds (28):** each case has a small board of its own whose origin event is at `now − ms`. It is named `t-<event>-<ms>-before` (at ms − 1) or `-after` (at ms + 1).

    | Event | Origin | Thresholds (ms) |
    | --- | --- | --- |
    | `flight` | an entry's `startedAt` | 1250, 1600 |
    | `glow` | an `ok` entry's `endedAt` | 3200 |
    | `alarm` | an `err` entry's `endedAt` | 6000 |
    | `switch` | `board.switchedAt`, a switch entry | 1600, 3200, 4800, 6400, 8000 |
    | `done` | a `done` entry's `startedAt` | 1100 |
    | `route` | the last stop's `startedAt`, three stops 1000 ms apart | 40000, 60000 |
    | `hands` | a running entry's `startedAt` | 60000, 600000 |
  - **Boards (21),** default options, named `board-<name>`:
    - `empty`, `idle-faded` (a route older than 60 s, nothing running);
    - `lanes` (three calls to one station at once), `inbound` (a hollow inbound memory pulse);
    - `pushed-0` (asked 0), `pushed-1` (asked 2, pushed 1);
    - `times-3`, `faults-1`, `faults-120`;
    - `context-none`, `context-0`, `context-69`, `context-70`, `context-90`, `context-100`;
    - `no-model`, `crew-3`, `crew-6`;
    - `blocked` (a `block` entry), `from-agents` (a call from a subagent), `all-running` (every station with a running call at once).
  - **Setups (18),** each on the busy board, named `setup-<option>-<value>`:
    - `setup-theme-auto|dark|light`;
    - `setup-layout-you-top|you-bottom`;
    - `setup-background-solid|transparent`;
    - `setup-colors-dark-equal` (`['node=#0a0c11']`) and `setup-colors-two` (`['accent=#ff9900', 'text=#eeeeee']`);
    - `setup-language-en|ru|es|fr|de`;
    - `setup-core-X`, `setup-core-ДОМ`, `setup-core-ABCDEFGHIJ`, `setup-core-<&">`.
- [ ] **Step 2: Write the test** in `hooks/golden.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { GOLDEN_CASES, fingerprint } from './golden-cases'
import { GOLDEN } from './golden-hashes'
import { drawMap, setupFrom } from './map'

test('the desktop drawing is unchanged, case by case', () => {
  expect(GOLDEN_CASES.length).toBe(68)
  expect(new Set(GOLDEN_CASES.map(g => g.name)).size).toBe(68)
  for (const g of GOLDEN_CASES) expect(`${g.name} ${fingerprint(drawMap(g.board, g.now, setupFrom(g.options)))}`).toBe(`${g.name} ${GOLDEN[g.name]}`)
})
```

- [ ] **Step 3: Capture on the unchanged code.** Run `bun scripts/golden.ts write && claude plugin test .`. Expected: all pass, and `scripts/golden-out/` holds 68 `.svg` files.
- [ ] **Step 4: Prove the guard bites.** Temporarily change the core's `stroke-width="1.3"` to `1.31` in `drawMap`. Run `bun scripts/golden.ts check`: expected, non-zero mismatches with offsets. Run `claude plugin test .`: expected, the golden test fails. Revert the change.
- [ ] **Step 5: Commit:** `git add .gitignore hooks/golden-cases.ts hooks/golden-hashes.ts hooks/golden.test.ts scripts/golden.ts && git commit -m "Capture the desktop drawing to guard the refactor"`

### Task 6: The scene and the SVG painter

**Files:**
- Create:
  - `hooks/palette.ts`: moved from `map.ts`: `list`, `Palette`, `DARK`, `LIGHT`, `COLOR_NAMES`, `colorsFrom`, `lightRules`;
  - `hooks/scene.ts`: moved: the drawing constants, `routeOf`, `TRAIL_HOLD_MS`, `TRAIL_FADE_MS`, and every drawing helper;
  - `hooks/svg.ts`.
- Modify:
  - `hooks/map.ts` (the drawing section goes; it imports `list` and `colorsFrom` from `./palette`);
  - `hooks/register.tsx` (`drawMap` from `./svg`);
  - `hooks/lot-map.test.tsx`, `hooks/golden.test.ts`, `scripts/golden.ts` (imports).

**Interfaces:**
- Produces, in `scene.ts`:
  - `type MotionClass = 'fast' | 'slow'`;
  - `type SceneNode = { tag: string; attrs: readonly (readonly [string, string])[]; children?: readonly (SceneNode | string)[]; motion?: MotionClass; isRestingBreath?: true; group?: string }`. `group` is set on top-level nodes only; the SVG painter ignores it.
  - `type Scene = { now: number; width: number; height: number; style: string; nodes: readonly SceneNode[]; isAnyRunning: boolean }`;
  - `sceneOf(board: Board, now: number, setup: Setup): Scene`.
- Produces `lightPairs(own: Partial<Palette>): Map<string, string>` in `palette.ts`: each dark value to its light value, skipping keys the person set and keys whose dark value equals one of their colours. `lightRules` is rebuilt on it, with identical output.
- Produces, in `svg.ts`, `toSvg(scene: Scene): string` and `drawMap(board: Board, now: number, setup: Setup): string`, which returns `toSvg(sceneOf(board, now, setup))`.
- Rules for the scene:
  - Attribute values and order are today's strings exactly. Text children are already escaped, as today.
  - `motion` is set on every `animate`, `animateMotion` and `animateTransform` child, by the spec's rule:
    - **fast:** pulse motion and opacity, ripple, the route head's dash offset, the end dot's fade-in, switch rings, the answer ring;
    - **slow:** breath, the running beat, both hands, crew rotation, glows, the cooling ring, beams, the route fade, the end dot's fade-out.
  - `isRestingBreath` is set on the breath circle.
  - `group`, used by the pixel painter's per-group cache in Task 8:
    - `ground`: the background rect and the contours, which change only with the theme, the background option or the size;
    - `spoke:<id>`: that station's spoke and its worn overlay, whose width follows the station's count;
    - `station:<id>`: that station's under and over nodes;
    - `route:<k>`: route leg k and its end dot;
    - `motion`: beams, flights and returns;
    - `crew`: the crew dots;
    - `core`: the breath, the core, the context ring and the core texts;
    - `rings`: the switch rings and the answer ring.
  - `isAnyRunning` is true when any recent entry is `run`.

- [ ] **Step 1: Write the failing test** in `hooks/golden.test.ts`:

```ts
import { sceneOf } from './scene'
import type { SceneNode } from './scene'

const animations = (nodes: readonly (SceneNode | string)[]): SceneNode[] =>
  nodes.flatMap(n => (typeof n === 'string' ? [] : [...(n.tag.startsWith('animate') ? [n] : []), ...animations(n.children ?? [])]))

test('every animation carries a motion class, every top-level node a group, and the breath is marked once', () => {
  for (const g of GOLDEN_CASES) {
    const scene = sceneOf(g.board, g.now, setupFrom(g.options))
    for (const a of animations(scene.nodes)) expect(`${g.name} ${a.motion}`).toMatch(/ (fast|slow)$/)
    expect(scene.nodes.filter(n => n.isRestingBreath).length).toBe(1)
    for (const n of scene.nodes) expect(`${g.name} ${n.group}`).toMatch(/ (ground|spoke:[a-z]+|station:[a-z]+|route:\d+|motion|crew|core|rings)$/)
  }
})
```

- [ ] **Step 2: Run it to verify it fails.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `golden.test.ts` fails to load (no `./scene`).
- [ ] **Step 3: Implement the split.** Move code without changing what it writes; `sceneOf` returns nodes in today's order. `shift` stays module state in `scene.ts`, set at the top of `sceneOf`.
- [ ] **Step 4: Run both checks.** Run `bun scripts/golden.ts check`. Expected: `0 mismatches`. Run `claude plugin test .`. Expected: all pass, the golden test included.
- [ ] **Step 5: Commit:** `git add hooks scripts/golden.ts && git commit -m "Split drawMap into a scene and an SVG painter, output unchanged"`

### Task 7: The timeline: an element's animated values at a moment

**Files:**
- Create: `hooks/paint/timeline.ts`
- Test: `hooks/paint.test.ts`

**Interfaces:**
- Consumes: `SceneNode` (Task 6), `Point` (Task 1).
- Produces:
  - `parseClock(text: string): number`, in ms, for `"0.800s"`, `"-1.234s"`, `".5s"`, `"1.4s"`;
  - `type Sampled = { values: Map<string, number>; offset?: Point; rotate?: { degrees: number; cx: number; cy: number } }`;
  - `sample(node: SceneNode, sceneNow: number, t: number): Sampled`, which evaluates `node`'s animation children at absolute time `t`, where each `begin` is relative to `sceneNow`;
  - `windowOf(anim: SceneNode, sceneNow: number): { from: number; to: number }`, the absolute span over which the animation's value changes (`to` is `Infinity` when indefinite).
  - `isChanging(node: SceneNode, sceneNow: number, t: number): boolean`: true when any animation in `node`, at any depth, has a window holding `t`.
- Semantics:
  - Values interpolate linearly over `values`, with optional `keyTimes`.
  - Before `begin`, an animation does not apply. After its end it holds its last value with `fill="freeze"`; without freeze it does not apply.
  - `repeatCount` is a number or `indefinite`.
  - Among animations of one attribute that apply, the latest `begin` wins.
  - `animateMotion` reads `path="M x y L x y"`; `animateTransform type="rotate"` reads `from` and `to` as `"deg cx cy"`.

- [ ] **Step 1: Write the failing tests:**

```ts
import { isChanging, parseClock, sample, windowOf } from './paint/timeline'
import type { SceneNode } from './scene'

const anim = (attrs: Record<string, string>): SceneNode => ({ tag: 'animate', attrs: Object.entries(attrs), motion: 'slow' })
const el = (...children: SceneNode[]): SceneNode => ({ tag: 'circle', attrs: [['opacity', '0']], children })

test('clock strings read as milliseconds', () => {
  expect([parseClock('0.800s'), parseClock('-1.234s'), parseClock('.5s'), parseClock('1.4s')]).toEqual([800, -1234, 500, 1400])
})

test('an opacity fade interpolates, freezes at its end, and does not apply before it begins', () => {
  const n = el(anim({ attributeName: 'opacity', values: '.75;0', begin: '-0.100s', dur: '1.600s', fill: 'freeze' }))
  near(sample(n, 1000, 1000).values.get('opacity')!, 0.703125)
  expect(sample(n, 1000, 3000).values.get('opacity')).toBe(0)
  const late = el(anim({ attributeName: 'opacity', values: '.7;0', begin: '0.500s', dur: '0.450s' }))
  expect(sample(late, 1000, 1200).values.has('opacity')).toBe(false)
  expect(sample(late, 1000, 2000).values.has('opacity')).toBe(false)
})

test('keyTimes hold a pulse at full strength and then fade it', () => {
  const n = el(anim({ attributeName: 'opacity', values: '1;1;0', keyTimes: '0;.82;1', begin: '0.000s', dur: '0.800s', fill: 'freeze' }))
  expect(sample(n, 0, 400).values.get('opacity')).toBe(1)
  near(sample(n, 0, 728).values.get('opacity')!, 0.5, 1e-3)
})

test('a counted repeat runs its laps and then freezes at its last value', () => {
  const n = el(anim({ attributeName: 'r', values: '40;66', begin: '0.000s', dur: '1.6s', repeatCount: '3', fill: 'freeze' }))
  near(sample(n, 0, 4000).values.get('r')!, 53)
  expect(sample(n, 0, 6000).values.get('r')).toBe(66)
  expect(windowOf(n.children![0] as SceneNode, 0)).toEqual({ from: 0, to: 4800 })
  expect([isChanging(n, 0, -1), isChanging(n, 0, 100), isChanging(n, 0, 4800), isChanging(n, 0, 6000)]).toEqual([false, true, false, false])
})

test('of two opacity animations, the one that began later wins once it has begun', () => {
  const n = el(
    anim({ attributeName: 'opacity', values: '0;.85', begin: '0.400s', dur: '.15s', fill: 'freeze' }),
    anim({ attributeName: 'opacity', values: '.85;0', begin: '40.000s', dur: '20.000s', fill: 'freeze' }),
  )
  expect(sample(n, 0, 1000).values.get('opacity')).toBe(0.85)
  near(sample(n, 0, 50_000).values.get('opacity')!, 0.425)
})

test('motion along a line and rotation about a point', () => {
  const move: SceneNode = { tag: 'circle', attrs: [], children: [{ tag: 'animateMotion', attrs: [['path', 'M0 0L10 0'], ['begin', '0.000s'], ['dur', '0.800s'], ['fill', 'freeze']], motion: 'fast' }] }
  expect(sample(move, 0, 400).offset).toEqual({ x: 5, y: 0 })
  const spin: SceneNode = { tag: 'g', attrs: [], children: [{ tag: 'animateTransform', attrs: [['attributeName', 'transform'], ['type', 'rotate'], ['from', '0 50 50'], ['to', '360 50 50'], ['begin', '-1.750s'], ['dur', '7.000s'], ['repeatCount', 'indefinite']], motion: 'slow' }] }
  expect(sample(spin, 0, 0).rotate).toEqual({ degrees: 90, cx: 50, cy: 50 })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `paint.test.ts` fails to load (no `./paint/timeline`).
- [ ] **Step 3: Implement `hooks/paint/timeline.ts`.**
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add hooks/paint/timeline.ts hooks/paint.test.ts && git commit -m "Evaluate the map's animations at any moment"`

### Task 8: The pixel painter, sized to the pane, with per-group caching

**Files:**
- Create: `hooks/paint/scene-paint.ts`, `scripts/bench.ts`
- Modify: `hooks/paint/canvas.ts` (add `toStraight`)
- Test: `hooks/paint.test.ts`

**Interfaces:**
- Consumes:
  - `Scene`, `SceneNode` with `group` (Task 6);
  - `sample`, `isChanging` (Task 7);
  - Task 1's primitives;
  - `drawText`, `FONT`, `TEXT_SCALE`;
  - `lightPairs`, `Palette` (Task 6).
- Produces:
  - `Canvas.toStraight(): Uint8Array`: straight RGBA bytes in a buffer the canvas reuses, valid until the next call. `toBase64()` now encodes it.
  - `type Picture = { width: number; height: number; scale: number }` and `pictureFor(rows: number): Picture`, as in Global Constraints;
  - `type PaintOptions = { light: boolean; colors: Partial<Palette> }`, where `colors` is `setup.colors`;
  - `class LayerCache { constructor(picture: Picture, options: PaintOptions); readonly repainted: string[]; readonly size: number }`. `repainted` holds the keys of cached layers built afresh (cache misses) by the last `paintScene`. Changing nodes painted directly each frame are not listed. `size` is the number of layers held.
  - `paintScene(scene: Scene, t: number, picture: Picture, options: PaintOptions, cache?: LayerCache): Canvas`.
- Rules:
  - **Splitting into layers.** Top-level nodes are walked in order and split into runs at every change of `group` and at every node that `isChanging(node, scene.now, t)`. One exception: the `isRestingBreath` node when `!scene.isAnyRunning` is not changing, and it is painted with its animations' first values.
  - **Keys.** A run of non-changing nodes is one cached layer. Its key is the group, plus each node's own tag and attributes with animation children left out, plus the values sampled at t for its animated attributes, rounded to 3 decimals. The key therefore does not change when a scene is rebuilt with a later `now`, as long as what is drawn is the same.
  - **Painted runs.** Changing nodes are painted directly every frame.
  - **Eviction.** After each `paintScene`, the cache drops every layer that frame did not use.
  - **Compositing.** Layers composite within their bounding boxes. The uncached path builds the same layers, so both paths agree byte for byte.
  - **Painting rules from the spec.** Text is unescaped and sized × `TEXT_SCALE`. With `light`, colours go through `lightPairs(colors)`.

- [ ] **Step 1: Write the failing tests.** Every test here is declared with `{ timeoutMs: 30000 }`:

```ts
import { LayerCache, paintScene, pictureFor } from './paint/scene-paint'
import { sceneOf } from './scene'
import { GOLDEN_CASES } from './golden-cases'
import type { Board, Entry } from '../types'

const SLOW = { timeoutMs: 30000 }
const P12 = pictureFor(12)
const P20 = pictureFor(20)
const at = (name: string) => GOLDEN_CASES.find(g => g.name === name)!
const scene = (name: string, now?: number) => { const g = at(name); return sceneOf(g.board, now ?? g.now, setupFrom(g.options)) }
const DARK_OPTS = { light: false, colors: {} }
const inCore = (p = P20) => [Math.round(230 * p.scale), Math.round(182 * p.scale)] as const
const ground = (p = P20) => [Math.round(4 * p.scale), Math.round(215 * p.scale)] as const
const held = (lastAt: number): Board => ({
  counts: { files: 1, shell: 1, web: 1 },
  entries: (['files', 'shell', 'web'] as const).map((station, k): Entry => ({ id: `h${k}`, station, label: 'x', from: 'core', startedAt: lastAt - (2 - k) * 1000, endedAt: lastAt - (2 - k) * 1000 + 500, status: 'ok' })),
})

test('toStraight gives straight bytes and toBase64 encodes them', () => {
  const c = new Canvas(2, 1)
  fill(c, roundRect(0, 0, 1, 1, 0), parseColor('#ff0000'), 1)
  const bytes = c.toStraight()
  expect([...bytes]).toEqual([255, 0, 0, 255, 0, 0, 0, 0])
  expect(c.toBase64()).toBe(bytes.toBase64())
})

test('the picture follows the pane: 408 to 1000 px tall, 34 px a row', () => {
  expect(pictureFor(20)).toEqual({ width: 727, height: 680, scale: 680 / 430 })
  expect(pictureFor(12).height).toBe(408)
  expect(pictureFor(40)).toEqual({ width: 1070, height: 1000, scale: 1000 / 430 })
})

test('a cached frame equals an uncached one', SLOW, () => {
  for (const p of [P12, P20]) {
    const s = scene('busy-default')
    const cache = new LayerCache(p, DARK_OPTS)
    for (const dt of [0, 130]) expect(paintScene(s, s.now + dt, p, DARK_OPTS, cache).toBase64() === paintScene(s, s.now + dt, p, DARK_OPTS).toBase64()).toBe(true)
  }
})

test('after a count changes, only that station and its spoke are repainted', SLOW, () => {
  const g = at('busy-default')
  const cache = new LayerCache(P12, DARK_OPTS)
  paintScene(sceneOf(g.board, g.now, setupFrom(g.options)), g.now, P12, DARK_OPTS, cache)
  const counted = { ...g.board, counts: { ...g.board.counts, skills: (g.board.counts.skills ?? 0) + 1 } }
  paintScene(sceneOf(counted, g.now, setupFrom(g.options)), g.now, P12, DARK_OPTS, cache)
  const fresh = cache.repainted.filter(k => !k.startsWith('route') && !k.startsWith('motion'))
  expect(fresh.some(k => k.startsWith('station:skills'))).toBe(true)
  expect(fresh.every(k => k.startsWith('station:skills') || k.startsWith('spoke:skills'))).toBe(true)
  expect(cache.repainted.some(k => k.startsWith('ground'))).toBe(false)
})

test('a route in its hold is painted once, then neither frames nor a rebuilt scene repaint it', SLOW, () => {
  const now = 2_000_000
  const cache = new LayerCache(P12, DARK_OPTS)
  paintScene(sceneOf(held(now - 10_000), now, setupFrom({})), now, P12, DARK_OPTS, cache)
  expect(cache.repainted.some(k => k.startsWith('route'))).toBe(true)
  paintScene(sceneOf(held(now - 10_000), now, setupFrom({})), now + 2000, P12, DARK_OPTS, cache)
  expect(cache.repainted.filter(k => k.startsWith('route'))).toEqual([])
  paintScene(sceneOf(held(now - 10_000), now + 1000, setupFrom({})), now + 3000, P12, DARK_OPTS, cache)
  expect(cache.repainted.filter(k => k.startsWith('route'))).toEqual([])
})

test('the cache keeps only the layers the last frame used', SLOW, () => {
  const cache = new LayerCache(P12, DARK_OPTS)
  const a = scene('busy-default')
  paintScene(a, a.now, P12, DARK_OPTS, cache)
  const used = cache.size
  for (let k = 0; k < 5; k++) {
    const g = at('busy-default')
    const b = sceneOf({ ...g.board, counts: { ...g.board.counts, files: (g.board.counts.files ?? 0) + k + 1 } }, g.now, setupFrom(g.options))
    paintScene(b, b.now, P12, DARK_OPTS, cache)
  }
  expect(cache.size).toBeLessThanOrEqual(used)
})

test('the core is the node colour, the corners are clear, and transparent leaves the ground empty', SLOW, () => {
  const s = scene('busy-default')
  const solid = paintScene(s, s.now, P20, DARK_OPTS)
  expect(solid.pixel(...inCore())).toEqual([18, 21, 28, 255])
  expect(solid.pixel(0, 0)[3]).toBe(0)
  expect(solid.pixel(...ground())).toEqual([10, 12, 17, 255])
  const clear = scene('setup-background-transparent')
  expect(paintScene(clear, clear.now, P20, DARK_OPTS).pixel(...ground())[3]).toBe(0)
})

test('on a light terminal the painter remaps as desktop does, keeping colours of ones own', SLOW, () => {
  const s = scene('busy-default')
  expect(paintScene(s, s.now, P12, { light: true, colors: {} }).pixel(...inCore(P12))).toEqual([255, 255, 255, 255])
  const g = at('busy-default')
  const own = setupFrom({ colors: ['node=#123456'] })
  const mine = sceneOf(g.board, g.now, own)
  expect(paintScene(mine, mine.now, P12, { light: true, colors: own.colors }).pixel(...inCore(P12))).toEqual([18, 52, 86, 255])
})

test('with nothing running the core does not breathe, and the cache repaints nothing between frames', SLOW, () => {
  const s = scene('board-idle-faded')
  const cache = new LayerCache(P12, DARK_OPTS)
  const a = paintScene(s, s.now, P12, DARK_OPTS, cache).toBase64()
  expect(paintScene(s, s.now + 2400, P12, DARK_OPTS, cache).toBase64() === a).toBe(true)
  expect(cache.repainted).toEqual([])
})

test('a fresh board, a board with no model and a core name outside the font all paint', SLOW, () => {
  for (const name of ['board-empty', 'board-no-model', 'setup-core-<&">']) expect(() => paintScene(scene(name), scene(name).now, P12, DARK_OPTS)).not.toThrow()
  const odd = sceneOf({ entries: [], counts: {} }, 0, setupFrom({ coreName: '日本🙂' }))
  expect(() => paintScene(odd, 0, P12, DARK_OPTS)).not.toThrow()
})
```

  `Canvas`, `parseColor`, `fill` and `roundRect` are already imported at the top of the file by Task 1's tests.
- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `paint.test.ts` fails to load (no `./paint/scene-paint`).
- [ ] **Step 3: Implement** `toStraight` in `canvas.ts`, and `hooks/paint/scene-paint.ts`.
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Write `scripts/bench.ts`** and run it with `bun scripts/bench.ts`. It warms up 10 frames of `busy-default` at `pictureFor(20)`, then prints:
  - the average ms of 40 frames with no board change;
  - the ms of the first frame after bumping `counts.files`;
  - the same two at `pictureFor(40)`.

  Expected: ≤ 7 ms and ≤ 20 ms at 20 rows. Over budget is reported as DONE_WITH_CONCERNS with the numbers; it never becomes a failing test.
- [ ] **Step 6: Look at a frame.** Add `bun scripts/golden.ts png <name> [rows]`, which writes `scripts/golden-out/<name>-<rows>.png` with `node:zlib`. Write `busy-default` at 20 and 40 rows and `setup-theme-light` at 20, and view each beside its SVG. Expected: the same picture apart from anti-aliasing.
- [ ] **Step 7: Commit:** `git add hooks/paint/canvas.ts hooks/paint/scene-paint.ts hooks/paint.test.ts scripts/golden.ts scripts/bench.ts && git commit -m "Paint the map's scene as pixels, sized to the pane, with cached layers"`

### Task 9: The motion query

**Files:**
- Create: `hooks/paint/motion.ts`
- Test: `hooks/paint.test.ts`

**Interfaces:**
- Consumes: `Scene`, `SceneNode` (Task 6), `windowOf` (Task 7), `Board`.
- Produces:
  - `type Rate = 0 | 1 | 15 | 20`;
  - `IDLE_CAP_MS = 300_000`;
  - `changedAt(board: Board): number`: the latest `startedAt`, `endedAt` or `switchedAt`, 0 when empty;
  - `motionAt(scene: Scene, t: number, boardChangedAt: number): { fps: Rate; wakeAt?: number }`.
- Rules:
  - 20 if a `fast` animation's window holds t, else 15 if a `slow` one's does, else 0.
  - The resting breath doesn't count when `!scene.isAnyRunning`.
  - 1 instead of 15 or 20 once `t − boardChangedAt ≥ IDLE_CAP_MS`.
  - With fps 0, `wakeAt` is the earliest window `from` after t, absent if none.

- [ ] **Step 1: Write the failing tests** (`Board` and `Entry` are already imported from Task 8):

```ts
import { IDLE_CAP_MS, changedAt, motionAt } from './paint/motion'

const NOW = 1_000_000
let seq = 0
const entry = (e: Partial<Entry> & Pick<Entry, 'station' | 'startedAt' | 'status'>): Entry => ({ id: `m${seq++}`, label: 'x', from: 'core', ...e })
const boardWith = (...entries: Entry[]): Board => ({ entries, counts: {} })
/** Stops 1000 ms apart, the last at `lastAt`; each finished 500 ms after it started. */
const boardWithRoute = (stations: Entry['station'][], lastAt: number): Board =>
  boardWith(...stations.map((station, k) => entry({ station, startedAt: lastAt - (stations.length - 1 - k) * 1000, endedAt: lastAt - (stations.length - 1 - k) * 1000 + 500, status: 'ok' })))

test('a call that just started flies at 20, a long call loops at 15, and a still map is 0', () => {
  const fresh = boardWith(entry({ station: 'shell', startedAt: NOW - 100, status: 'run' }))
  expect(motionAt(sceneOf(fresh, NOW, setupFrom({})), NOW, changedAt(fresh)).fps).toBe(20)
  const long = boardWith(entry({ station: 'shell', startedAt: NOW - 30_000, status: 'run' }))
  expect(motionAt(sceneOf(long, NOW, setupFrom({})), NOW, changedAt(long)).fps).toBe(15)
  const done = boardWith(entry({ station: 'shell', startedAt: NOW - 200_000, endedAt: NOW - 199_000, status: 'ok' }))
  expect(motionAt(sceneOf(done, NOW, setupFrom({})), NOW, changedAt(done))).toEqual({ fps: 0 })
})

test('each leg of the route holds for 40 seconds from its own stop and then fades at 15', () => {
  const route = boardWithRoute(['files', 'shell', 'web'], NOW - 10_000)
  const s = sceneOf(route, NOW, setupFrom({}))
  expect(motionAt(s, NOW, changedAt(route))).toEqual({ fps: 0, wakeAt: NOW - 11_000 + 40_000 })
  expect(motionAt(s, NOW + 35_000, changedAt(route)).fps).toBe(15)
})

test('a subagent that never reported back slows to 1 fps after five minutes without a change', () => {
  const stuck: Board = { ...boardWith(entry({ station: 'agents', startedAt: NOW - 400_000, status: 'run', from: 'agents', agentId: 'a1' })), agents: ['a1'] }
  const s = sceneOf(stuck, NOW, setupFrom({}))
  expect(motionAt(s, NOW, NOW - 100_000).fps).toBe(15)
  expect(motionAt(s, NOW, NOW - IDLE_CAP_MS).fps).toBe(1)
})

test('a fresh session is still', () => {
  const empty: Board = { entries: [], counts: {} }
  expect(motionAt(sceneOf(empty, NOW, setupFrom({})), NOW, changedAt(empty))).toEqual({ fps: 0 })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: the file fails to load.
- [ ] **Step 3: Implement `hooks/paint/motion.ts`.**
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add hooks/paint/motion.ts hooks/paint.test.ts && git commit -m "Tell the helper how fast the map moves"`

### Task 10: Terminal decisions: layout, picture mode, refusals, helper policy, the stdout protocol

**Files:**
- Create: `hooks/terminal.ts`
- Test: `hooks/terminal.test.tsx`

**Interfaces:**
- Produces, all pure (no `$`):
  - `CELL_RATIO = 2.1`, `MIN_RING_ROWS = 12`;
  - `ringBox(bodyRows: number, bodyColumns: number): { columns: number; rows: number } | undefined`;
  - `type Env = Readonly<Record<string, string | undefined>>`;
  - `ENV_NAMES = ['TERM_PROGRAM', 'TERM', 'KITTY_WINDOW_ID', 'TMUX', 'ZELLIJ', 'STY', 'SSH_CONNECTION', 'SSH_TTY', 'TMPDIR', 'HOME'] as const`. register.tsx reads each with a literal `$.env.get('…')`.
  - `terminalAllows(env: Env): boolean`;
  - `socketPath(env: Env, tag: string): string`;
  - `newTag(random: () => number): string`, 8 characters of `[a-z0-9]`;
  - `type Refusal = { next: 'text' } | { next: 'pause' } | { next: 'carry-on' }`;
  - `class PictureGate { accepted(now: number): void; refused(deny: string, now: number): Refusal; rendered(now: number): { reopen: boolean }; showsPicture(): boolean }`;
  - `class HelperPolicy { exited(now: number): { restartIn: number } | { giveUp: true } }`, restarting after 1000 and 5000 ms and giving up on the third exit within 60 000 ms;
  - `class Coalescer<T> { offer(value: T, now: number): T | undefined; due(now: number): T | undefined; waitMs(now: number): number | undefined }`. At most one value per 100 ms, the newest winning. `waitMs` says when a pending value becomes due, so the caller can arm a timer.
  - `type HelperLine = { kind: 'R' } | { kind: 'F'; name: string; width: number; height: number; generation: number } | { kind: 'S'; text: string } | { kind: 'E'; message: string }`;
  - `class LineReader { push(piece: string): HelperLine[] }`, which reassembles lines across pieces and drops malformed ones.
- Gate rules:
  - **Before any blit is accepted:** an alt refusal, followed by another at least 2000 ms later, → `text`.
  - **After an accepted blit:** an alt refusal → `pause`. **Not mounted** → `pause`. **The start-up capability message** and anything else → `carry-on`.
  - **Reopening:** `rendered(now)` at least 60 000 ms after a switch to text returns `{ reopen: true }` and makes `showsPicture()` true. The caller then starts a fresh helper; this does not count toward `HelperPolicy`.

- [ ] **Step 1: Write the failing tests** in `hooks/terminal.test.tsx`:

```ts
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
```

- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `terminal.test.tsx` fails to load.
- [ ] **Step 3: Implement `hooks/terminal.ts`.**
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add hooks/terminal.ts hooks/terminal.test.tsx && git commit -m "Decide when and how the terminal shows the map as a picture"`

### Task 11: The helper

**Files:**
- Create:
  - `helper/shm.c`, the C shim;
  - `helper/shm.ts`, its loader;
  - `helper/ring.ts`;
  - `helper/loop.ts`;
  - `helper/server.ts`;
  - `helper/painter.ts`, the entry point;
  - `helper/feed.ts`, a hand-check reader;
  - `helper/*.spec.ts`.
- Reference: the spike's `ring-test/helper/painter.ts` and `shm.c` (in the dev-mods folder), and `.superpowers/sdd/2026-11-12-terminal-ring/spike-shm-report.md`.

**Interfaces:**
- Consumes:
  - `sceneOf` (Task 6), `setupFrom` (map.ts);
  - `paintScene`, `LayerCache`, `pictureFor`, `Canvas.toStraight` (Task 8);
  - `motionAt`, `changedAt` (Task 9).
- Produces:
  - `helper/shm.ts`: `type Shm = { put(name: string, bytes: Uint8Array): number; drop(name: string): number; read(name: string, length: number): Uint8Array | undefined }`, and `loadShm(): Shm`.
    - It compiles `shm.c` with `cc` from `bun:ffi`, and throws if `cc` fails.
    - `put` returns 0, or −errno: −EEXIST (−17) while the name is unread.
    - `read` exists for tests and the feed reader.
  - `helper/ring.ts`: `class NameRing { constructor(tag: string, shm: Shm, size = 8); clean(): void; write(bytes: Uint8Array, now: number): { name: string; generation: number } | undefined; expire(now: number): number }`.
    - `write` tries each name from the next index and numbers frames with a running generation. `undefined` means all are unread: backpressure, so skip the frame.
    - `expire` drops names written more than 1000 ms ago that are still unread.
  - `helper/loop.ts`:
    - `type HelperSetup = { options: Record<string, unknown>; light: boolean; rows: number }`;
    - `type HelperStats = { state: 'running' | 'still' | 'paused'; frames: number; skips: number; expired: number; paintMs: number; shmMs: number }`;
    - `class FrameLoop { constructor(deps: { now: () => number; paint: (scene: Scene, t: number, picture: Picture, options: PaintOptions) => Uint8Array; write: (bytes: Uint8Array, now: number) => { name: string; generation: number } | undefined; expire: (now: number) => number; emit: (line: string) => void; schedule: (ms: number, fn: () => void) => () => void }); setBoard(board: Board, now: number, changedAt: number): void; setSetup(setup: HelperSetup): void; pause(): void; resume(): void; stats(): HelperStats }`.
  - Loop rules:
    - **Scene.** It builds the scene with `sceneOf(board, postedNow, setupFrom(options))`. It samples at `deps.now()`, or, when that differs from the posted `now` by more than 1000 ms, at `deps.now()` plus the offset fixed at that post.
    - **Rate.** It runs at `motionAt`'s fps, drift-corrected. Each new board cancels the pending timer and re-plans.
    - **Painting even when still.** It paints one frame:
      - when the fps falls to 0 (the last frame);
      - on `resume()` and on `setSetup()`, so a pane shown again while still gets a fresh frame.
    - **Sleeping.** At 0 fps it sleeps until `wakeAt`, a new board, or `resume`, and schedules one `expire` 1100 ms after its last frame.
    - **Output.** It emits `F <name> <width> <height> <generation>` for each frame, and `S …` once a second only while frames flow.
  - `helper/server.ts`:
    - `prepareSocket(path: string): void` creates the directory with mode 0700 and removes a stale socket file.
    - `serve(path: string, loop: FrameLoop): { stop(): void }` is built on `Bun.serve({ unix })` and handles:
      - `POST /setup` with a `HelperSetup`;
      - `POST /board` with `{ board, now, changedAt }`;
      - `POST /pause`, `POST /resume`;
      - `POST /stats`, which returns `HelperStats` as JSON.

      Anything else answers 404. A malformed body answers 400 and changes nothing.
  - `helper/painter.ts`: run as `bun helper/painter.ts <socket path> <tag>`.
    - **Starting:** `prepareSocket`, `loadShm` (on failure print `E …` and exit 2), `ring.clean()`, `serve`, then print `R`.
    - **Stopping:** on SIGTERM, SIGINT, SIGHUP or SIGPIPE, on an error writing stdout, or when a 2 s poll finds `process.ppid === 1`, it unlinks unread names, stops the server, removes the socket and exits. It never reads stdin.
  - `helper/feed.ts`: `bun helper/feed.ts`. It reads `F` lines on stdin and, for each, reads and drops the name, as a terminal would. It counts frames a second, for the hand check.

- [ ] **Step 1: Write the failing specs:**

```ts
// helper/ring.spec.ts
import { expect, test } from 'bun:test'
import { NameRing } from './ring'
import type { Shm } from './shm'

const fakeShm = () => {
  const live = new Map<string, Uint8Array>()
  const shm: Shm = {
    put: (name, bytes) => (live.has(name) ? -17 : (live.set(name, bytes), 0)),
    drop: name => (live.delete(name) ? 0 : -2),
    read: name => live.get(name),
  }
  return { shm, live }
}

test('frames go round eight names with rising generations; all eight unread skips the frame', () => {
  const { shm, live } = fakeShm()
  const ring = new NameRing('abcd1234', shm)
  const written = Array.from({ length: 8 }, (_, k) => ring.write(new Uint8Array([k]), k)!)
  expect(new Set(written.map(w => w.name)).size).toBe(8)
  expect(written.every(w => /^\/lm-abcd1234-[0-7]$/.test(w.name))).toBe(true)
  expect(written.map(w => w.generation)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  expect(ring.write(new Uint8Array([9]), 9)).toBeUndefined()
  live.delete(written[3]!.name)
  expect(ring.write(new Uint8Array([10]), 10)).toEqual({ name: written[3]!.name, generation: 9 })
})

test('clean drops all eight names, and expire drops frames unread after a second', () => {
  const { shm, live } = fakeShm()
  const ring = new NameRing('abcd1234', shm)
  ring.write(new Uint8Array([1]), 0)
  ring.write(new Uint8Array([2]), 900)
  expect(ring.expire(1500)).toBe(1)
  expect(live.size).toBe(1)
  ring.clean()
  expect(live.size).toBe(0)
})
```

  Write the other three specs with these assertions:
  - **`helper/loop.spec.ts`**, with a fake clock whose `schedule` queues callbacks and returns a canceller, and `paint` returning a 4-byte array. Use the Task 9 board helpers, copied in. Counts are ±1.
    - A fresh call emits about 20 `F` lines in 1000 ms.
    - A long-running call emits about 15.
    - An idle board emits exactly one last frame, then nothing for 5000 ms.
    - A stuck run with `changedAt` 300 000 ms back emits about one a second.
    - `resume()` while still emits one frame.
    - A board posted with `now` 5000 ms behind the fake clock samples at the fake clock minus 5000 (check through the scene's `now`).
    - `S` lines appear while frames flow and not while still.
  - **`helper/server.spec.ts`:**
    - `prepareSocket` makes the directory with mode 0700 and removes a stale file.
    - Start `serve` under `os.tmpdir()`, then POST `/setup`, `/board` and `/pause` with `fetch(url, { unix })`, and assert the loop received them.
    - A malformed body gets 400; `/stats` returns JSON.
  - **`helper/shm.spec.ts`:** `loadShm()`; `put` then `read` returns the same bytes; a second `put` returns −17; `drop` then `read` returns `undefined`.
- [ ] **Step 2: Run them to verify they fail.** Run `bun test helper`. Expected: the module imports fail.
- [ ] **Step 3: Implement** `shm.c`, `shm.ts`, `ring.ts`, `loop.ts`, `server.ts`, `painter.ts` and `feed.ts`. Start from the spike's shim, which compiled with `cc` here.
- [ ] **Step 4: Run the specs.** Run `bun test helper`. Expected: all pass.
- [ ] **Step 5: Run it end to end, by hand,** and write the commands and output into the report.
  1. Run `bun helper/painter.ts /tmp/lot-map-test0001/h.sock test0001 > /tmp/lm-out.txt &` and then `tail -f /tmp/lm-out.txt | bun helper/feed.ts &`.
  2. POST `/setup` (`rows: 20`) and the busy golden board with `curl --unix-socket /tmp/lot-map-test0001/h.sock`.
  3. Expected: `R` first, then the feed counts about 20 frames a second, and `S` shows a paint of 7 ms or less.
  4. Send SIGTERM. Expected: none of the 8 `/lm-test0001-k` names can be read.
  5. Start it again, then `kill -9` it while frames flow. Start it once more with the same tag. Expected: after its `R`, none of the earlier names can be read.
- [ ] **Step 6: Commit:** `git add helper && git commit -m "Add the helper that paints the terminal map into shared memory"`

### Task 12: Wiring the plugin to the helper

**Files:**
- Modify:
  - `hooks/register.tsx` (the Pane `ui.render` hook, a `config.set` hook, the `lot-map` command);
  - `hooks/map.ts` (`Setup.terminal`, `setupFrom`);
  - `hooks/text.ts` (one string per language for `/lot-map stats`, and one for the toast when the socket is refused);
  - `.claude-plugin/plugin.json` (the option);
  - `types/index.d.ts` (the tag in `PluginState`).
- Modify (Step 1 only): the throwaway `ring-test` mod.
- Test: `hooks/terminal.test.tsx`

**Interfaces:**
- Consumes: Task 10's exports; `pictureFor` (Task 8); `changedAt` (Task 9).
- Produces:
  - `Setup.terminal: 'picture' | 'text'`, where anything but `'text'` is `'picture'`;
  - the `userConfig` field `terminal`: `{ "type": "string", "title": "In the terminal", "options": ["picture", "text"], "default": "picture", "description": "How the map shows in a terminal: as a moving picture in Ghostty or kitty (needs bun; uses shared memory and a local socket), or as text." }`;
  - the state atom `{ plugin: 'lot-map', key: 'tag' }`;
  - `/lot-map stats`, which answers `{ text }` with:
    - a first line `mode: picture` or `mode: text (<reason>)`;
    - `frames: <n> taken · <m> refused`, followed by the refusal texts;
    - the helper's state and restarts;
    - blit ms average and p95;
    - the helper's last `S` line;
    - board posts sent and coalesced.
- **Where things happen:**
  - **The render hook** (terminal surface) is the one place that decides the mode and starts the helper, the first time picture mode applies. It also posts boards, because it re-runs on every board write.
    - It offers each new board to the `Coalescer` with `now` and `changedAt`.
    - When `offer` returns undefined, it arms `$.clock.after(waitMs)` in its closure (once per pending value) to flush `due()`.
    - It also posts `/resume` when the pane was paused, and `/setup` when `rows` or `light` changed.
  - **The stdout loop** lives in a closure written in the render hook, for the session's life. If Step 1 shows that does not survive, it moves to `session.start`'s closure.
  - **`light`** is `setup.theme === 'auto' && themeRow.startsWith('light')`. With an explicit `light` or `dark`, the scene is already in that palette.
  - **The theme row** is read on the first render and in a `config.set` hook on `{ key: 'theme' }`, which then posts `/setup` and invalidates.
  - **A refused or failing `$.http.fetch`** gives the text view and one `$.ui.toast` naming the cause. The helper is stopped.

- [ ] **Step 1: Check the spike gaps in Ghostty first.** This is a checkpoint with the person. Change the ring-test spike so it sends frames as Task 11 will:
  - 727×680;
  - a ring of 8 reused names;
  - `F name w h generation`;
  - blits that carry `generation`;
  - a bun unix-socket server in its helper.

  Then add `/ring-test probe`, which reports each of these:
  - one `$.http.fetch(…, { socketPath })` round trip;
  - a helper spawned from inside a `ui.render` hook's closure still alive and blitting after 10 s;
  - the Image mounted with a 1×1 ground placeholder, then 727×680 frames;
  - 30 s of frames on the 8 reused names, with any refusals or dropped frames;
  - the pane hidden and shown again while the map is still: a frame appears, not a blank box.

  The person runs it in Ghostty and pastes `/ring-test stats`. For each check that fails, apply the spec's fallback and ledger it before Step 2.
- [ ] **Step 2: Write the failing tests,** appended to `hooks/terminal.test.tsx`. Every test here uses `{ timeoutMs: 30000 }`:

```ts
const SLOW = { timeoutMs: 30000 }
const DOCK = { title: 'Map', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} } as const
const PANE = { plugin: 'lot-map', component: 'Pane', requestId: 'lot-map', props: DOCK } as const
const GHOSTTY = { TERM_PROGRAM: 'ghostty', TMPDIR: '/var/folders/ab/cdefgh/T/', HOME: '/Users/x' }
const path = (p: { url: string }) => new URL(p.url).pathname

type Spawn = (feed: (line: string) => void) => AsyncGenerator<{ stream: 'stdout'; text: string }, { value: { code: number | null; signal: string | null } }>

/** A world with a fake helper that prints R, then F lines when told to. */
const world = (on: On, opts: { env?: Record<string, string>; blit?: (n: number) => { deny?: string }; bun?: boolean; fetchOk?: boolean; spawn?: Spawn; theme?: { value: string } } = {}) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, opts.env ?? GHOSTTY)
  const spawned: string[][] = []
  const posts: { url: string; body: unknown }[] = []
  const blits: { name: string; generation: number; at: number }[] = []
  let stopped = 0
  let feed: (line: string) => void = () => {}
  const standard: Spawn = async function* (push) {
    const lines: string[] = ['R\n']
    let wake: (() => void) | undefined
    feed = line => { lines.push(line); wake?.() }
    try {
      while (true) {
        while (lines.length > 0) yield { stream: 'stdout', text: lines.shift()! }
        await new Promise<void>(r => { wake = r })
      }
    } finally { stopped++ }
  }
  on('process.run', () => (opts.bun === false ? { deny: 'not found' } : { value: { exitCode: 0, stdout: '1.4.4\n', stderr: '' } }))
  on('fs.exists', () => ({ value: opts.bun !== false }))
  on('process.spawn', (_, e) => { spawned.push([...e.argv]); return (opts.spawn ?? standard)(line => feed(line)) })
  on('http.fetch', (_, e) => {
    posts.push({ url: e.url, body: JSON.parse(String(e.init?.body ?? 'null')) })
    return opts.fetchOk === false ? { deny: 'refused by policy' } : { value: { status: 200, ok: true, headers: {}, text: '{}' } }
  })
  on('ui.blit', (_, e) => { const s = e.source as { shm: string; generation: number }; blits.push({ name: s.shm, generation: s.generation, at: clock.now() }); return { value: opts.blit?.(blits.length) ?? {} } })
  on('config.list', () => ({ value: opts.theme === undefined ? [] : [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme.value, provider: { kind: 'engine' }, isLocked: false }] }))
  on('config.set', (_, e) => { if (opts.theme !== undefined) opts.theme.value = String(e.value); return { value: e.value } })
  on('tool.call', () => ({ result: {} }))
  return { clock, spawned, posts, blits, stopped: () => stopped, frame: (k: number) => feed(`F /lm-abcd1234-${k % 8} 727 680 ${k + 1}\n`) }
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
  w.frame(2) // wakes the fake helper so its loop can see it was ended
  await w.clock.settle()
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
  const w = world(on, { spawn: async function* () { starts++; yield { stream: 'stdout', text: starts === 1 ? 'E no cc\n' : 'S x\n' }; return { value: { code: 2, signal: null } } } })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.advance(10_000)
  expect(starts).toBe(3)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
})

test('a refused socket request gives the text view', SLOW, async ($, on) => {
  const w = world(on, { fetchOk: false })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  w.frame(0) // wakes the fake helper so its loop can see it was ended
  await w.clock.settle()
  expect(w.stopped()).toBe(1)
})

test('with Claude Code on a light theme and the map on auto, setup says light; a theme change posts setup again', SLOW, async ($, on) => {
  const w = world(on, { theme: { value: 'light-daltonized' } })
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  const setups = () => w.posts.filter(p => path(p) === '/setup').map(p => (p.body as { light: boolean }).light)
  expect(setups()).toEqual([true])
  await $.config.set({ key: 'theme', value: 'dark' })
  await w.clock.settle()
  expect(setups()).toEqual([true, false])
})

test('/lot-map stats names the mode and the frames', SLOW, async ($, on) => {
  const w = world(on)
  await $.ui.mount({ ...PANE, surface: 'terminal' })
  await w.clock.settle()
  w.frame(0)
  await w.clock.settle()
  const out = await $.command.run({ name: 'lot-map', args: 'stats' })
  expect(out.text).toMatch(/^mode: picture/)
  expect(out.text).toMatch(/frames: 1 taken · 0 refused/)
})

test('desktop still gets the Svg and no helper is started for it', SLOW, async ($, on) => {
  const w = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(w.spawned.length).toBe(0)
})
```

  Where a kit shape differs, adjust the shape but keep each assertion. Shapes to watch: the `process.run` refusal, the `config.set` answer, and `$.command.run`'s result. Every hook is registered inside `world`, before the test's first `$` call, as the kit requires.
- [ ] **Step 3: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: the new tests fail, and Task 10's pass.
- [ ] **Step 4: Add the option and the tag.** Add `terminal` to `Setup`, `setupFrom` and `plugin.json`, and add the tag atom to `types/index.d.ts`.
- [ ] **Step 5: Implement the wiring in `hooks/register.tsx`.**
  - **Finding `bun`.** `$.process.run(['bun', '--version'])`; if that is refused or rejects, `${HOME}/.bun/bin/bun` when `$.fs.exists` says it is there; otherwise the text view.
  - **Starting.** Start the helper from the render hook's closure: `$.process.spawn({ argv: [bun, \`${$.plugin.root}/helper/painter.ts\`, socket, tag] })`.
  - **Reading the helper.** Read its stdout through `LineReader`. On `R`, post `/setup` and the current board. Relay each `F` to `$.ui.blit({ requestId: 'lot-map', key: 'map', source: { shm, format: 'rgba', width, height, generation } })` and feed the result to `PictureGate`. An `E` line is recorded for stats and ends the loop.
  - **Restarts and reopening.** A loop that ends goes to `HelperPolicy`. When `PictureGate.rendered` returns `reopen`, start a fresh helper outside the policy.
  - **The tree.** Draw it as the spec says: the Image `key="map"` sized to the ring box, with the 1×1 placeholder, or Step 1's fallback, until the first frame, then the last frame's shm source. The "now" line and the feed follow, every Text with `wrap="truncate-end"`.
  - **Failures.** Every engine call is wrapped in `quietly`; a failure draws the text view.
- [ ] **Step 6: Run everything and validate.** Run `claude plugin test . && bun test helper && claude plugin validate .`. Expected: all pass, the 42 original tests included, and `✔ Validation passed`.
- [ ] **Step 7: Commit:** `git add hooks .claude-plugin/plugin.json types && git commit -m "Show the map as a moving picture in Ghostty and kitty, painted by the helper"`

### Task 13: Documentation, version, the person's check, cleanup

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json` (version), `.claude-plugin/marketplace.json` (version, if it carries one).
- Delete: the `ring-test` mod folder.

- [ ] **Step 1: Update `README.md`.**
  - **Install, line 25:** where the picture shows (Ghostty or kitty, local, fullscreen, docked; needs bun), and where text stays (iTerm2 and why, tmux, zellij, screen, ssh, VS Code).
  - **Options table:** add `terminal`.
  - **Colours:** in a terminal, `auto` follows Claude Code's theme.
  - **"What it shows and what it keeps":**
    - the helper process, shared memory and the local socket, and that no frames touch the disk;
    - that the board passes through Claude Code's request machinery, where another plugin that watches requests could see its labels;
    - that it reads the `theme` setting.
  - **Font:** its licence and data size.
  - **Commands:** `/lot-map stats`.
  - **Developing:** add `bun test helper` and `bun scripts/bench.ts`.
- [ ] **Step 2: Set the version.** Set `"version": "0.4.0"`, then run `claude plugin validate .`. Expected: `✔ Validation passed`.
- [ ] **Step 3: The person's check.** They disable the installed lot-map in `/plugin` and start `claude --plugin-dir /Users/froch/Development/claude/lot-map` in Ghostty, fullscreen, with the pane docked, then work for five minutes. They check:
  - the map moves smoothly with no stutter at events, and typing is normal;
  - `/lot-map stats` shows frames taken with no ongoing refusals;
  - the controller samples CPU for the helper, Claude Code and Ghostty, and Ghostty's memory, against the spec's Done means;
  - after quitting, no `/lm-<tag>-k` name can be read (with `helper/feed.ts`'s read);
  - iTerm2 shows the text view with no helper process;
  - `terminal: text` gives text;
  - the desktop app shows the map as before.

  Record the numbers under the spec's Done means.
- [ ] **Step 4: Final checks.** Run `bun scripts/golden.ts check && claude plugin test . && bun test helper && claude plugin validate . && bun scripts/bench.ts`. Expected: `0 mismatches`, all pass, budgets met.
- [ ] **Step 5: Clean up.** Delete `/Users/froch/.claude/dev-mods/4e805010-94ea-4bde-a455-ed356869fa4a/ring-test`.
- [ ] **Step 6: Commit:** `git add README.md .claude-plugin docs/superpowers/specs/2026-11-12-terminal-ring-design.md && git commit -m "Describe the terminal map, version 0.4.0"`

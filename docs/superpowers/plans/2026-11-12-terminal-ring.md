# The Map in the Terminal: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Draw lot-map's ring as a moving picture in the terminal pane (iTerm2 3.5+, kitty, Ghostty, fullscreen), keeping the desktop SVG byte-identical and falling back to today's text view everywhere else.

**Architecture:** `drawMap` is split into a scene (`sceneOf`) that keeps today's exact SVG strings per element, plus two painters. `toSvg` joins the strings for desktop. A pixel painter samples each element's SMIL animations at a moment and paints an RGBA frame with its own anti-aliased rasteriser and an embedded font. In the terminal, one frame loop paints at 10, 5, 1 or 0 fps by the scene's motion classes and swaps the frame into a keyed `Image` with `$.ui.blit`.

**Tech Stack:** TypeScript hooks module for Claude Code 2.1.322+ (no DOM, no Node at run time); tests with `claude-code/testing` under `claude plugin test .`; development scripts run with bun.

**Spec:** `docs/superpowers/specs/2026-11-12-terminal-ring-design.md`. Read it before any task. Its Constraints section explains every number below.

## Global Constraints

- **Desktop output.** Desktop, VS Code and mobile output of `drawMap` stays byte-identical to `main` at 2b48eb0.
- **No run-time I/O.** No network, files or processes at run time, and no run-time dependencies. Development scripts may download sources into gitignored folders.
- **`$` rules.** Every engine call is spelled `$.noun.method(...)` inside a hook or a closure in it. `$` is never stored, passed or returned (`claude plugin validate` refuses it).
- **Failures stay contained.** A failure in drawing or in the loop never reaches a tool call, a turn or the conversation. Wrap it as `register.tsx`'s `quietly` does. A paint that throws inside a render draws the text view for that render.
- **Picture:** `PICTURE = { width: 736, height: 688, scale: 1.6 }`, sent as `{ rgba, width, height }` base64. Tests and code use `PICTURE`, never the literals, so that Task 4's gate may change the scale.
- **Rates.**
  - 10 fps while a `fast` animation changes; 5 fps while only `slow` ones change; 0 fps when nothing changes.
  - 1 fps once the board has not changed for 300 000 ms.
  - The board's change time is the latest `startedAt`, `endedAt` or `switchedAt` on it.
- **Ring box.**
  - `R = floor(bodyRows × 0.6)`;
  - `C = round(R × 2.1 × 460/430)`;
  - if `C > bodyColumns` then `C = bodyColumns` and `R = floor(C / (2.1 × 460/430))`;
  - text view when `R < 12`, when the placement is `inline`, or when the option `terminal` is `text`.
- **Text below the picture.** Every Text has `wrap="truncate-end"`. The tree never exceeds `bodyRows` rows.
- **Refusal prefixes.** Alt: `the Image draws its alt here:`. Not mounted: `no Image of its own is mounted`.
- **Theme.** `auto` in the terminal: Claude Code's `theme` row starting with `light` → light; anything else or no row → dark.
- **Option and version.** New option `terminal`: `picture` (default) or `text`. Version 0.4.0.
- **Frame budget.** At most 20 ms average per frame at full size in the plugin, as `/lot-map stats` reports it in the real pane.
- **Tests.**
  - The kit's `expect` has no `toBeCloseTo`. Each test file defines `const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)`.
  - A test file whose import is missing fails as a whole, as one `(fail)` line saying it did not load, and its other tests drop out of the count.
- **Pixel convention.** Pixel (x, y) covers [x, x+1) × [y, y+1) and is sampled at its centre (x+0.5, y+0.5). Storage is premultiplied RGBA, 8 bits a channel. Colours are exact only where alpha is 255.

## Review Focus

1. **A core name outside the font.** A core name of one's own with characters the font lacks (emoji, CJK, `<&"`) should draw each missing character as a hollow box, never throw, and leave the desktop SVG as today. Tests in Task 2 and Task 8.
2. **A very long label.** A 200-character Bash description, or a 120-character path, should cut to one row and never push the picture out of the pane. Test in Task 11.
3. **Pane sizes at the edges.** A narrow dock, 19 or 20 body rows, or a very tall pane should draw the picture or the text view as the formula says, never an Image larger than the body. Tests in Task 10 and Task 11.
4. **A subagent that never reported back, or a call that hangs,** should slow the loop to 1 fps after five minutes without a board change, not run at 5 fps forever. Test in Task 9.
5. **A fresh session** (empty board, no context, no model) should paint without throwing and be still (0 fps) once nothing runs. Tests in Task 8 and Task 9.

---

### Task 1: Rasteriser primitives

**Files:**
- Create: `hooks/paint/canvas.ts`, `hooks/paint/path.ts`
- Test: `hooks/paint.test.ts`

**Interfaces:**
- Produces, in `canvas.ts`:
  - `type Rgb = readonly [number, number, number]`;
  - `parseColor(hex: string): Rgb`, accepting `#rgb` and `#rrggbb`;
  - `class Canvas { readonly width: number; readonly height: number; constructor(width: number, height: number); clear(): void; copyFrom(other: Canvas): void; pixel(x: number, y: number): [number, number, number, number]; toBase64(): string }`. `pixel` and `toBase64` give straight RGBA 0–255. `toBase64` skips the division where alpha is 255.
- Produces, in `path.ts`:
  - `type Point = { x: number; y: number }`, `type Polyline = { points: Point[]; closed: boolean }`, `type Matrix = readonly [number, number, number, number, number, number]` (SVG `matrix(a b c d e f)` order);
  - `translate(x, y): Matrix`, `scale(k): Matrix`, `rotateAbout(degrees, cx, cy): Matrix`, `multiply(a, b): Matrix`;
  - `parsePath(d: string, m?: Matrix): Polyline[]`. It reads M L H V C S Q A Z and their relative forms, numbers that run together (`c0-4 3-6.2`, `h.1`, `.5.5`), and the SVG arc parameterisation. Curves are flattened to within 0.25 px after `m`.
  - `circle(cx, cy, r, m?)` and `ellipse(cx, cy, rx, ry, m?)`, each one closed polyline starting at (cx + r, cy) and running clockwise on screen, as SVG's does; `roundRect(x, y, w, h, r, m?)`; `line(x1, y1, x2, y2, m?)`, all returning `Polyline[]`;
  - `dashed(lines: Polyline[], pattern: readonly number[], offset: number, pathLength?: number): Polyline[]`. Each polyline is dashed from its own start. With `pathLength`, `pattern` and `offset` are in units where that polyline's length is `pathLength`.
  - `fill(c: Canvas, shape: Polyline[], color: Rgb, alpha: number): void` (non-zero winding), and `stroke(c: Canvas, lines: Polyline[], width: number, color: Rgb, alpha: number, cap: 'butt' | 'round'): void`. Both draw source-over; joins are always round.
- The anti-aliasing method is the implementer's choice.

- [ ] **Step 1: Write the failing tests** in `hooks/paint.test.ts`:

```ts
import { expect, test } from 'claude-code/testing'
import { Canvas, parseColor } from './paint/canvas'
import { circle, dashed, fill, line, parsePath, rotateAbout, roundRect, stroke } from './paint/path'
import { STATIONS, setupFrom } from './map'

const near = (a: number, b: number, eps = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(eps)
const WHITE = parseColor('#ffffff')

test('a filled circle covers its middle, half of a pixel its edge cuts in two, and nothing outside', () => {
  const c = new Canvas(40, 40)
  fill(c, circle(20, 20, 10.5), parseColor('#e1ac6e'), 1)
  expect(c.pixel(20, 20)).toEqual([225, 172, 110, 255])
  expect(c.pixel(2, 2)).toEqual([0, 0, 0, 0])
  const edge = c.pixel(30, 20)[3]
  expect(edge).toBeGreaterThan(60)
  expect(edge).toBeLessThan(200)
})

test('a rounded rect leaves its corners clear', () => {
  const c = new Canvas(100, 80)
  fill(c, roundRect(0, 0, 100, 80, 19.2), parseColor('#0a0c11'), 1)
  expect(c.pixel(0, 0)[3]).toBe(0)
  expect(c.pixel(50, 40)).toEqual([10, 12, 17, 255])
})

test('a ring over pathLength 1 with dash offset .75 shows its first quarter, from the top clockwise', () => {
  const c = new Canvas(60, 60)
  stroke(c, dashed(circle(30, 30, 20, rotateAbout(-90, 30, 30)), [1, 1], 0.75, 1), 3, WHITE, 1, 'butt')
  expect(c.pixel(44, 16)[3]).toBeGreaterThan(200)
  expect(c.pixel(16, 44)[3]).toBe(0)
  expect(c.pixel(16, 16)[3]).toBe(0)
})

test('dashes 2 on 5 off cut a line into pieces two long', () => {
  const pieces = dashed(line(0, 0, 70, 0), [2, 5], 0)
  expect(pieces.length).toBe(10)
  for (const p of pieces) near(Math.abs(p.points[p.points.length - 1]!.x - p.points[0]!.x), 2, 1e-5)
})

test('every station icon parses, arcs and smooth curves included, inside its 20-unit box', () => {
  for (const s of STATIONS) {
    const pts = parsePath(s.icon).flatMap(p => p.points)
    expect(pts.length).toBeGreaterThan(3)
    for (const p of pts) {
      expect(Math.abs(p.x)).toBeLessThan(10)
      expect(Math.abs(p.y)).toBeLessThan(10)
    }
  }
  const you = parsePath(STATIONS[0]!.icon).flatMap(p => p.points)
  near(Math.min(...you.map(p => p.y)), -7, 0.3)
  near(Math.max(...you.map(p => p.x)), 6.5, 0.05)
})

test('a round-capped stroke reaches half its width past the end of the line; a butt one stops there', () => {
  const c = new Canvas(40, 20)
  stroke(c, line(10, 10, 30, 10), 6, WHITE, 1, 'round')
  expect(c.pixel(32, 10)[3]).toBeGreaterThan(200)
  const butt = new Canvas(40, 20)
  stroke(butt, line(10, 10, 30, 10), 6, WHITE, 1, 'butt')
  expect(butt.pixel(31, 10)[3]).toBe(0)
})
```

- [ ] **Step 2: Run the tests to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: one `(fail)` line for `paint.test.ts` not loading (no `./paint/canvas`), and the 42 existing tests pass.
- [ ] **Step 3: Implement `hooks/paint/canvas.ts` and `hooks/paint/path.ts`** with the signatures above.
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: 48 pass, 0 fail.
- [ ] **Step 5: Commit:** `git add hooks/paint/canvas.ts hooks/paint/path.ts hooks/paint.test.ts && git commit -m "Add the rasteriser for the terminal map: canvas, paths, dashes, fill and stroke"`

### Task 2: Two font candidates and text

**Files:**
- Create:
  - `scripts/font/ttf.ts`: a minimal TrueType reader for `head`, `hhea`, `hmtx`, `OS/2` (`sCapHeight`), `cmap` format 4, `loca`, and `glyf` with composite glyphs;
  - `scripts/font/build-outline.ts`, `scripts/font/build-stroke.ts`;
  - `hooks/paint/font.ts`, `hooks/paint/text.ts`;
  - generated `hooks/paint/font-outline.ts` and `hooks/paint/font-stroke.ts`;
  - `hooks/paint/OFL.txt`.
- Modify: `.gitignore` (add `scripts/font/vendor/`).
- Test: `hooks/paint.test.ts`.

**Interfaces:**
- Consumes: Task 1.
- Produces, in `hooks/paint/font.ts`:
  - `type FontFace = { kind: 'outline' | 'stroke'; unitsPerEm: number; ascent: number; capHeight: number; advance: number; strokeWidth: number; glyphs: Readonly<Record<string, string>> }`. Glyphs are SVG path data in font units with y up. Both faces are monospaced at `advance`. `strokeWidth` is in font units and used only by `stroke` faces.
  - `type Font = { regular: FontFace; bold: FontFace }`;
  - `COVERAGE: string`, holding every character in:
    - U+0020–U+007E;
    - U+00C0–U+00FF;
    - U+0400–U+045F;
    - `·↓→…` (U+00B7, U+2193, U+2192, U+2026);
  - `STILL_TEXT: string`, holding every character the checkpoint still draws:
    - the station names in `en`, `ru` and `de`;
    - digits;
    - `%+×↓·`;
    - `CLAUDE`, `opus 5.5`;
  - `missing(font: Font, text: string): string[]`.
- Produces, in `hooks/paint/text.ts`:
  - `type TextRun = { text: string; color: Rgb }`;
  - `type TextSpec = { runs: TextRun[]; x: number; y: number; size: number; anchor: 'start' | 'middle'; letterSpacing?: number; bold?: boolean; alpha?: number; rim?: { color: Rgb; width: number } }`, in canvas pixels with `y` the baseline;
  - `textWidth(font: Font, text: string, size: number, letterSpacing?: number): number`, equal to `n × (advance × size / unitsPerEm + letterSpacing)`. Letter-spacing follows every character, the last included, as browsers do.
  - `drawText(c: Canvas, font: Font, spec: TextSpec): void`. Draws the rim first under all runs, as a round-joined stroke of `width`. A missing character is a hollow box `advance` wide and `capHeight` tall.
- Produces `OUTLINE: Font` (`font-outline.ts`) and `STROKE: Font` (`font-stroke.ts`).

- [ ] **Step 1: Download sources** into a new, empty `scripts/font/vendor/`. They are untrusted data; the scripts read them by path.
  - `JetBrainsMono-Regular.ttf`, `JetBrainsMono-Bold.ttf` and `OFL.txt` from `https://raw.githubusercontent.com/JetBrains/JetBrainsMono/master/` (`fonts/ttf/` for the fonts);
  - `rowmans.jhf` (Hershey Roman Simplex) from `https://raw.githubusercontent.com/kamalmostafa/hershey-fonts/master/hershey-fonts/`, with that repository's licence notice.

  Copy `OFL.txt` to `hooks/paint/OFL.txt`. Write one licence line at the top of each generated file.
- [ ] **Step 2: Write the failing tests:**

```ts
import { COVERAGE, STILL_TEXT, missing } from './paint/font'
import { OUTLINE } from './paint/font-outline'
import { STROKE } from './paint/font-stroke'
import { drawText, textWidth } from './paint/text'

const inkColumns = (c: Canvas): [number, number] => {
  let l = c.width, r = -1
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (c.pixel(x, y)[3] > 0) { l = Math.min(l, x); r = Math.max(r, x) }
  return [l, r]
}

test('the outline font covers every character the map can draw; the stroke font covers the still', () => {
  expect(missing(OUTLINE, COVERAGE)).toEqual([])
  expect(missing(STROKE, STILL_TEXT)).toEqual([])
})

test('text anchored in the middle is centred on x less half the trailing letter-spacing', () => {
  const adv = (OUTLINE.regular.advance / OUTLINE.regular.unitsPerEm) * 20
  near(textWidth(OUTLINE, 'HHH', 20, 4), 3 * (adv + 4))
  const c = new Canvas(200, 40)
  drawText(c, OUTLINE, { runs: [{ text: 'HHH', color: WHITE }], x: 100, y: 30, size: 20, anchor: 'middle', letterSpacing: 4 })
  const [l, r] = inkColumns(c)
  near((l + r + 1) / 2, 98, 0.75)
})

test('a character the font lacks is a hollow box, and nothing throws', () => {
  for (const font of [OUTLINE, STROKE]) {
    const c = new Canvas(60, 40)
    drawText(c, font, { runs: [{ text: '日', color: WHITE }], x: 10, y: 30, size: 20, anchor: 'start' })
    const [l, r] = inkColumns(c)
    expect(r - l).toBeGreaterThan(8)
    expect(c.pixel(Math.round((l + r) / 2), 24)[3]).toBe(0)
  }
})

test('a rim is drawn around the letters in its own colour', () => {
  const c = new Canvas(80, 40)
  drawText(c, OUTLINE, { runs: [{ text: 'O', color: WHITE }], x: 40, y: 30, size: 24, anchor: 'middle', rim: { color: parseColor('#0a0c11'), width: 5.6 } })
  let x = 0
  while (x < c.width && c.pixel(x, 22)[3] < 255) x++
  expect(c.pixel(x, 22)).toEqual([10, 12, 17, 255])
})
```

- [ ] **Step 3: Run the tests to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `paint.test.ts` fails to load (no `./paint/font`).
- [ ] **Step 4: Implement `scripts/font/ttf.ts` and `scripts/font/build-outline.ts`.** Running `bun scripts/font/build-outline.ts scripts/font/vendor/JetBrainsMono-Regular.ttf scripts/font/vendor/JetBrainsMono-Bold.ttf > hooks/paint/font-outline.ts` writes `export const OUTLINE: Font = …`. It holds exactly the `COVERAGE` glyphs, with composites resolved into one path and coordinates rounded to integer font units.
- [ ] **Step 5: Implement `scripts/font/build-stroke.ts`.** Running `bun scripts/font/build-stroke.ts scripts/font/vendor/rowmans.jhf > hooks/paint/font-stroke.ts` writes `STROKE`.
  - **Latin** comes from Roman Simplex, each glyph centred in a fixed advance (the widest Latin capital).
  - **Cyrillic letters and `ä ö ü ß`** in `STILL_TEXT` are drawn by hand as stroke data in the script. The repository's Cyrillic sets are double-stroked and don't match.
  - **Bold** is the same glyphs with 1.6 × `strokeWidth`.
  - **Full `COVERAGE` for this candidate** is a separate piece of work. It happens only if the person chooses it at the checkpoint (Task 3).
- [ ] **Step 6: Implement `hooks/paint/font.ts` and `hooks/paint/text.ts`.** Outline faces are filled; stroke faces are stroked with round caps at `strokeWidth × size / unitsPerEm`.
- [ ] **Step 7: Run the whole suite.** Run `claude plugin test .`. Expected: all pass. Run `wc -c hooks/paint/font-*.ts` and note the sizes for Task 3.
- [ ] **Step 8: Commit:** `git add .gitignore scripts/font/*.ts hooks/paint/font.ts hooks/paint/text.ts hooks/paint/font-outline.ts hooks/paint/font-stroke.ts hooks/paint/OFL.txt hooks/paint.test.ts && git commit -m "Add two font candidates and text drawing for the terminal map"`

### Task 3: Checkpoint: the person picks the font and judges label size

**Files:**
- Modify: the throwaway mod `/Users/froch/.claude/dev-mods/4e805010-94ea-4bde-a455-ed356869fa4a/ring-test/`. If this session's mods folder is gone, copy it anywhere and start `claude --plugin-dir <that folder>` in iTerm2. Nothing from it returns to the repo.
- Modify: the spec's Font section (record the decision).
- After the decision:
  - **Rename** the chosen font file to `hooks/paint/font-data.ts`.
  - **Delete** the other font and its build script. If stroke wins, delete `scripts/font/ttf.ts` and `hooks/paint/OFL.txt` as well.

**Interfaces:**
- Produces, in `hooks/paint/font-data.ts`:
  - `FONT: Font`;
  - `TEXT_SCALE: number`: 1, or the label scale the person asks for. Text drawn at size `s` is drawn at `s × TEXT_SCALE` about the same anchor and baseline.

- [ ] **Step 1: Build the still in the mod.**
  - **Copy:** copy `hooks/paint/{canvas,path,font,text,font-outline,font-stroke}.ts` into `ring-test/hooks/paint/`. Copy the `STATIONS` icon strings, the drawing constants from `hooks/map.ts`, and the `en`/`ru`/`de` station names into a new `ring-test/hooks/still.ts`; it imports nothing from outside the mod.
  - **Draw:** with the Task 1–2 primitives on a `Canvas` of 736×688 (scale 1.6):
    - ground, contours, spokes, node discs and real icons;
    - each station's name at 11.5 units with a 3.5-unit rim in the ground colour;
    - a count at 9.5;
    - a bold fault badge "3" at 9;
    - `CLAUDE` at 17 with letter-spacing 2.5;
    - `39%` at 8 and `opus 5.5` at 9.
  - **Command:** `/ring-test still <outline|stroke> <en|ru|de>` stops the loop and draws that still through the existing Image.
  - **Validate:** run `claude plugin validate <ring-test>`. Expected: `✔ Validation passed`.
- [ ] **Step 2: Show the person.** Ask them to run `/ring-test still outline en`, `still stroke en`, then both with `ru` and `de`.
  - Each at `/ring-test rows 20` and `rows 14`: the ring at 34 and 24 body rows.
  - Then the tallest the pane allows. Make the iTerm2 window taller first, keeping `rows` at most 0.6 × the pane's body rows, so the picture is never partly hidden.
  - They compare the labels with the terminal text in the feed below.
- [ ] **Step 3: Record the decision.** Write the pick and any label scale in the spec's Font section (`Decided: …`).
- [ ] **Step 4: Finish the chosen font.**
  - **Outline chosen:** rename `font-outline.ts` to `font-data.ts`, exporting `FONT` and `TEXT_SCALE`, and delete the stroke files.
  - **Stroke chosen:** extend `build-stroke.ts` until `missing(STROKE, COVERAGE)` is `[]`. Accented Latin is composed from base and mark; Cyrillic and `Ð Þ ß æ ø` are drawn. Then rename it and delete the outline files.

  Either way, point the Task 2 tests at `FONT`, with `expect(missing(FONT, COVERAGE)).toEqual([])`.
- [ ] **Step 5: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 6: Commit:** `git add hooks/paint scripts/font hooks/paint.test.ts docs/superpowers/specs/2026-11-12-terminal-ring-design.md && git commit -m "Choose the terminal map's font"`. Use `git rm` for deleted files.

### Task 4: Checkpoint: timers from a render, and the cost of the primitives in the pane

**Files:**
- Modify: the throwaway `ring-test` mod.
- Modify: the spec's Constraints section (record results).

- [ ] **Step 1: Add a busy mode to `ring-test`:** `/ring-test busy <5|10>`. It is the Task 3 still with motion, painted every frame from the Task 1–2 primitives at 736×688:
  - two stations cooling (opacity fades) and one running (spreading ring and both hands);
  - a pulse in flight, the breath, a circling dot;
  - all labels.

  The unchanging parts are drawn once into a second `Canvas`, which is copied in per frame.
- [ ] **Step 2: Test timers through a render hook's `$`.** On a render, start a `$.clock.after` chain from the render hook's own `$`, blitting every 100 ms for 10 s, plus one `$.clock.after(40_000, …)` blit. Record in stats:
  - how many of the chain's blits were taken;
  - whether the 40 s one ran;
  - the first blit's result after a fresh session start.
- [ ] **Step 3: The person runs each check and reads `/ring-test stats`:**
  - **Rates:** `busy 10` and `busy 5`, each for 2 minutes, with Activity Monitor on iTerm2 and `claude`. Note the average CPU and memory, the frame ms, and how typing feels.
  - **Height-only resize:** resize the iTerm2 window's height alone, and check whether `renders` rises.
  - **Hidden tab:** open the lot-map pane as a second tab, switch away and back, and check whether `renders` rises.
  - **Session start:** in a fresh session (`/clear` or a new tab) with the pane open, note the first blit result and the chain counts.
- [ ] **Step 4: Gate.**
  - **Frame ms above 20 with busy 10:** take the numbers to the person before continuing. Options: drop `PICTURE.scale` to 1.4, or composite less. The spec's 1.6 changes only with their agreement.
  - **The chain or the 40 s wait from a render's `$` did not run:** Task 11's loop starts its chains from the `$` of the hooks that change the board (`tool.call`, `turn.step`, `turn.complete`, `skill.prompt`, `session.compact`) and from `ui.render` only for the first frame. Note it in the spec.
- [ ] **Step 5: Record the numbers and findings** under the spec's Constraints.
- [ ] **Step 6: Commit:** `git add docs/superpowers/specs/2026-11-12-terminal-ring-design.md && git commit -m "Record what the pane showed about timers and frame cost"`

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
    - `blocked` (a `block` entry), `from-agents` (a call from a subagent).
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
  - `type SceneNode = { tag: string; attrs: readonly (readonly [string, string])[]; children?: readonly (SceneNode | string)[]; motion?: MotionClass; isRestingBreath?: true }`;
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
  - `isAnyRunning` is true when any recent entry is `run`.

- [ ] **Step 1: Write the failing test** in `hooks/golden.test.ts`:

```ts
import { sceneOf } from './scene'
import type { SceneNode } from './scene'

const animations = (nodes: readonly (SceneNode | string)[]): SceneNode[] =>
  nodes.flatMap(n => (typeof n === 'string' ? [] : [...(n.tag.startsWith('animate') ? [n] : []), ...animations(n.children ?? [])]))

test('every animation in every case carries a motion class, and the breath is marked once', () => {
  for (const g of GOLDEN_CASES) {
    const scene = sceneOf(g.board, g.now, setupFrom(g.options))
    for (const a of animations(scene.nodes)) expect(`${g.name} ${a.motion}`).toMatch(/ (fast|slow)$/)
    expect(scene.nodes.filter(n => n.isRestingBreath).length).toBe(1)
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
- Semantics:
  - Values interpolate linearly over `values`, with optional `keyTimes`.
  - Before `begin`, an animation does not apply. After its end it holds its last value with `fill="freeze"`; without freeze it does not apply.
  - `repeatCount` is a number or `indefinite`.
  - Among animations of one attribute that apply, the latest `begin` wins.
  - `animateMotion` reads `path="M x y L x y"`; `animateTransform type="rotate"` reads `from` and `to` as `"deg cx cy"`.

- [ ] **Step 1: Write the failing tests:**

```ts
import { parseClock, sample, windowOf } from './paint/timeline'
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

### Task 8: The pixel painter

**Files:**
- Create: `hooks/paint/scene-paint.ts`
- Test: `hooks/paint.test.ts`

**Interfaces:**
- Consumes:
  - `Scene`, `SceneNode` (Task 6);
  - `sample` (Task 7);
  - Task 1's primitives;
  - `drawText`, `FONT`, `TEXT_SCALE` (Tasks 2–3);
  - `lightPairs`, `Palette` (Task 6).
- Produces:
  - `PICTURE = { width: 736, height: 688, scale: 1.6 } as const`, with `width = round(460 × scale)` and `height = round(430 × scale)`;
  - `type PaintOptions = { light: boolean; colors: Partial<Palette> }`. `light` remaps the scene's dark colours with `lightPairs(colors)`; `colors` is `setup.colors`.
  - `class LayerCache { constructor(scene: Scene, options: PaintOptions) }`. It holds each run of static nodes between animated ones, painted once, and composites each within its bounding box. The uncached path builds the same layers, so the two paths agree byte for byte.
  - `paintScene(scene: Scene, t: number, options: PaintOptions, cache?: LayerCache): Canvas`.
- Painting rules:
  - Every attribute the scene carries is honoured: fill, stroke, widths, opacity, dashes, `pathLength`, transforms, `paint-order="stroke"` rims, anchors, letter-spacing, tspans, `font-weight="700"`.
  - Text children are unescaped (`&lt; &gt; &amp; &quot;`) and sized × `TEXT_SCALE`.
  - When `!scene.isAnyRunning`, the `isRestingBreath` node is painted with its animations' first values.

- [ ] **Step 1: Write the failing tests:**

```ts
import { LayerCache, PICTURE, paintScene } from './paint/scene-paint'
import { sceneOf } from './scene'
import { GOLDEN_CASES, fingerprint } from './golden-cases'

const at = (name: string) => GOLDEN_CASES.find(g => g.name === name)!
const scene = (name: string) => { const g = at(name); return sceneOf(g.board, g.now, setupFrom(g.options)) }
const DARK_OPTS = { light: false, colors: {} }
// Inside the core, above the percentage and the name: only the core's own fill is there.
const inCore = [Math.round(230 * PICTURE.scale), Math.round(182 * PICTURE.scale)] as const
const ground = [Math.round(4 * PICTURE.scale), Math.round(215 * PICTURE.scale)] as const

test('the picture has the PICTURE size and the same input paints the same frame', () => {
  const s = scene('busy-default')
  const a = paintScene(s, s.now, DARK_OPTS)
  expect([a.width, a.height]).toEqual([PICTURE.width, PICTURE.height])
  expect(fingerprint(a.toBase64())).toBe(fingerprint(paintScene(s, s.now, DARK_OPTS).toBase64()))
})

test('a cached frame equals an uncached one', () => {
  const s = scene('busy-default')
  const cache = new LayerCache(s, DARK_OPTS)
  for (const dt of [0, 130, 900]) expect(fingerprint(paintScene(s, s.now + dt, DARK_OPTS, cache).toBase64())).toBe(fingerprint(paintScene(s, s.now + dt, DARK_OPTS).toBase64()))
})

test('the core is the node colour, the corners are clear, and transparent leaves the ground empty', () => {
  const s = scene('busy-default')
  const solid = paintScene(s, s.now, DARK_OPTS)
  expect(solid.pixel(...inCore)).toEqual([18, 21, 28, 255])
  expect(solid.pixel(0, 0)[3]).toBe(0)
  expect(solid.pixel(...ground)).toEqual([10, 12, 17, 255])
  const clear = scene('setup-background-transparent')
  expect(paintScene(clear, clear.now, DARK_OPTS).pixel(...ground)[3]).toBe(0)
})

test('on a light terminal the painter remaps as desktop does, keeping colours of ones own', () => {
  const s = scene('busy-default')
  expect(paintScene(s, s.now, { light: true, colors: {} }).pixel(...inCore)).toEqual([255, 255, 255, 255])
  const g = at('busy-default')
  const own = setupFrom({ colors: ['node=#123456'] })
  const mine = sceneOf(g.board, g.now, own)
  expect(paintScene(mine, mine.now, { light: true, colors: own.colors }).pixel(...inCore)).toEqual([18, 52, 86, 255])
})

test('with nothing running the core does not breathe', () => {
  const s = scene('board-idle-faded')
  expect(fingerprint(paintScene(s, s.now, DARK_OPTS).toBase64())).toBe(fingerprint(paintScene(s, s.now + 2400, DARK_OPTS).toBase64()))
})

test('a fresh board, a board with no model and a core name outside the font all paint', () => {
  for (const name of ['board-empty', 'board-no-model', 'setup-core-<&">']) expect(() => paintScene(scene(name), scene(name).now, DARK_OPTS)).not.toThrow()
  const odd = sceneOf({ entries: [], counts: {} }, 0, setupFrom({ coreName: '日本🙂' }))
  expect(() => paintScene(odd, 0, DARK_OPTS)).not.toThrow()
})

test('a busy cached frame paints within 5 ms on average in the test runtime', () => {
  const s = scene('busy-default')
  const cache = new LayerCache(s, DARK_OPTS)
  const start = performance.now()
  for (let k = 0; k < 20; k++) paintScene(s, s.now + k * 100, DARK_OPTS, cache).toBase64()
  expect((performance.now() - start) / 20).toBeLessThan(5)
})
```

  The 5 ms test is a proxy: the test runtime runs at about bun speed, and the plugin measured about 4× slower. The real gate is `/lot-map stats` in Task 12.
- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `paint.test.ts` fails to load (no `./paint/scene-paint`).
- [ ] **Step 3: Implement `hooks/paint/scene-paint.ts`.**
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass. If only the 5 ms test fails, take the measured average to the person.
- [ ] **Step 5: Look at a frame.** Add `bun scripts/golden.ts png <name>`, which writes `scripts/golden-out/<name>.png` with `node:zlib`. Write `busy-default` and `setup-theme-light`, and view each beside its SVG in a browser. Expected: the same picture apart from anti-aliasing.
- [ ] **Step 6: Commit:** `git add hooks/paint/scene-paint.ts hooks/paint.test.ts scripts/golden.ts && git commit -m "Paint the map's scene as pixels"`

### Task 9: The motion query

**Files:**
- Create: `hooks/paint/motion.ts`
- Test: `hooks/paint.test.ts`

**Interfaces:**
- Consumes: `Scene`, `SceneNode` (Task 6), `windowOf` (Task 7), `Board`.
- Produces:
  - `type Rate = 0 | 1 | 5 | 10`;
  - `IDLE_CAP_MS = 300_000`;
  - `changedAt(board: Board): number`: the latest `startedAt`, `endedAt` or `switchedAt` on the board, 0 when empty;
  - `motionAt(scene: Scene, t: number, boardChangedAt: number): { fps: Rate; wakeAt?: number }`.
- Rules:
  - `fps` is 10 if a `fast` animation's window holds `t`, else 5 if a `slow` one's does, else 0.
  - The resting breath's animations don't count when `!scene.isAnyRunning`.
  - It becomes 1 instead of 5 or 10 once `t − boardChangedAt ≥ IDLE_CAP_MS`.
  - When `fps` is 0, `wakeAt` is the earliest window `from` after `t`, and is absent when there is none.

- [ ] **Step 1: Write the failing tests:**

```ts
import { IDLE_CAP_MS, changedAt, motionAt } from './paint/motion'
import type { Board, Entry } from '../types'

const NOW = 1_000_000
let seq = 0
const entry = (e: Partial<Entry> & Pick<Entry, 'station' | 'startedAt' | 'status'>): Entry => ({ id: `m${seq++}`, label: 'x', from: 'core', ...e })
const boardWith = (...entries: Entry[]): Board => ({ entries, counts: {} })
/** Stops 1000 ms apart, the last at `lastAt`; each finished 500 ms after it started. */
const boardWithRoute = (stations: Entry['station'][], lastAt: number): Board =>
  boardWith(...stations.map((station, k) => entry({ station, startedAt: lastAt - (stations.length - 1 - k) * 1000, endedAt: lastAt - (stations.length - 1 - k) * 1000 + 500, status: 'ok' })))

test('a call that just started flies at 10, a long call loops at 5, and a still map is 0', () => {
  const fresh = boardWith(entry({ station: 'shell', startedAt: NOW - 100, status: 'run' }))
  expect(motionAt(sceneOf(fresh, NOW, setupFrom({})), NOW, changedAt(fresh)).fps).toBe(10)
  const long = boardWith(entry({ station: 'shell', startedAt: NOW - 30_000, status: 'run' }))
  expect(motionAt(sceneOf(long, NOW, setupFrom({})), NOW, changedAt(long)).fps).toBe(5)
  const done = boardWith(entry({ station: 'shell', startedAt: NOW - 200_000, endedAt: NOW - 199_000, status: 'ok' }))
  expect(motionAt(sceneOf(done, NOW, setupFrom({})), NOW, changedAt(done))).toEqual({ fps: 0 })
})

test('each leg of the route holds for 40 seconds from its own stop and then fades at 5', () => {
  const route = boardWithRoute(['files', 'shell', 'web'], NOW - 10_000)
  const s = sceneOf(route, NOW, setupFrom({}))
  expect(motionAt(s, NOW, changedAt(route))).toEqual({ fps: 0, wakeAt: NOW - 11_000 + 40_000 })
  expect(motionAt(s, NOW + 35_000, changedAt(route)).fps).toBe(5)
})

test('a subagent that never reported back slows to 1 fps after five minutes without a change', () => {
  const stuck: Board = { ...boardWith(entry({ station: 'agents', startedAt: NOW - 400_000, status: 'run', from: 'agents', agentId: 'a1' })), agents: ['a1'] }
  const s = sceneOf(stuck, NOW, setupFrom({}))
  expect(motionAt(s, NOW, NOW - 100_000).fps).toBe(5)
  expect(motionAt(s, NOW, NOW - IDLE_CAP_MS).fps).toBe(1)
})

test('a fresh session is still', () => {
  const empty: Board = { entries: [], counts: {} }
  expect(motionAt(sceneOf(empty, NOW, setupFrom({})), NOW, changedAt(empty))).toEqual({ fps: 0 })
})
```

- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `paint.test.ts` fails to load (no `./paint/motion`).
- [ ] **Step 3: Implement `hooks/paint/motion.ts`.**
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add hooks/paint/motion.ts hooks/paint.test.ts && git commit -m "Tell the frame loop how fast the map moves"`

### Task 10: Terminal layout and the picture gate

**Files:**
- Create: `hooks/terminal.ts`
- Test: `hooks/terminal.test.tsx`

**Interfaces:**
- Consumes: `Rate` (Task 9).
- Produces:
  - `CELL_RATIO = 2.1`, `MIN_RING_ROWS = 12`;
  - `ringBox(bodyRows: number, bodyColumns: number): { columns: number; rows: number } | undefined`;
  - `ALT_PREFIX`, `UNMOUNTED_PREFIX` (Global Constraints), `RETRY_MS = [100, 300, 900] as const`, `SECOND_PROBE_MS = 2000`, `RETEST_MS = 60_000`;
  - `type Refusal = { next: 'retry'; inMs: number } | { next: 'text' } | { next: 'sleep' } | { next: 'carry-on' }`;
  - `class PictureGate { accepted(now: number): void; refused(deny: string, now: number): Refusal; rendered(now: number): { probe: boolean }; showsPicture(): boolean }`;
  - `delayFor(fps: Rate, lastFrameMs: number): number | undefined`, which is `undefined` for 0 and otherwise `max(0, 1000/fps − lastFrameMs)`.
- Gate rules:
  - **Before any blit is accepted:**
    - The first alt refusal → `retry` in `SECOND_PROBE_MS`.
    - An alt refusal less than `SECOND_PROBE_MS` after the first → `retry` for the rest of that time.
    - One at or after it → `text`, and `showsPicture()` turns false.
  - **After any accepted blit:** an alt refusal → `sleep` (until the next render). It never switches to text.
  - **Not mounted** → `retry` at 100, 300, 900, then `sleep`. Any other refusal → `carry-on`.
  - **`rendered(now)`:**
    - asks for a probe on the first render and on any render after a refusal;
    - turns `showsPicture()` true again at least `RETEST_MS` after the switch to text (and asks for a probe);
    - resets the not-mounted retries.

- [ ] **Step 1: Write the failing tests** in `hooks/terminal.test.tsx`:

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { PictureGate, delayFor, ringBox } from './terminal'

const ALT = 'the Image draws its alt here: this terminal draws no images'

test('the ring box follows the pane and gives way to text below twelve rows', () => {
  expect(ringBox(34, 89)).toEqual({ columns: 45, rows: 20 })
  expect(ringBox(20, 89)).toEqual({ columns: 27, rows: 12 })
  expect(ringBox(19, 89)).toBeUndefined()
  expect(ringBox(40, 60)).toEqual({ columns: 54, rows: 24 })
  expect(ringBox(100, 60)).toEqual({ columns: 60, rows: 26 })
  expect(ringBox(34, 40)).toEqual({ columns: 40, rows: 17 })
  expect(ringBox(34, 26)).toBeUndefined()
})

test('an alt refusal asks for a second probe; the second switches to text; a render a minute later tries again', () => {
  const g = new PictureGate()
  expect(g.rendered(0)).toEqual({ probe: true })
  expect(g.refused(ALT, 100)).toEqual({ next: 'retry', inMs: 2000 })
  expect(g.refused(ALT, 1100)).toEqual({ next: 'retry', inMs: 1000 })
  expect(g.showsPicture()).toBe(true)
  expect(g.refused(ALT, 2200)).toEqual({ next: 'text' })
  expect(g.showsPicture()).toBe(false)
  expect(g.rendered(30_000)).toEqual({ probe: false })
  expect(g.showsPicture()).toBe(false)
  expect(g.rendered(62_300)).toEqual({ probe: true })
  expect(g.showsPicture()).toBe(true)
})

test('once a blit is taken, alt refusals only pause the loop, and other refusals carry on', () => {
  const g = new PictureGate()
  g.accepted(0)
  expect(g.refused(ALT, 10)).toEqual({ next: 'sleep' })
  expect(g.refused(ALT, 5000)).toEqual({ next: 'sleep' })
  expect(g.refused('too many blits this second', 6000)).toEqual({ next: 'carry-on' })
  expect(g.showsPicture()).toBe(true)
  expect(g.rendered(7000)).toEqual({ probe: true })
})

test('a refusal before the Image is mounted is retried three times, then the loop sleeps', () => {
  const g = new PictureGate()
  const deny = 'no Image of its own is mounted under key map'
  expect([g.refused(deny, 0), g.refused(deny, 100), g.refused(deny, 400), g.refused(deny, 1300)]).toEqual([
    { next: 'retry', inMs: 100 }, { next: 'retry', inMs: 300 }, { next: 'retry', inMs: 900 }, { next: 'sleep' },
  ])
})

test('the next frame waits the rest of its interval', () => {
  expect([delayFor(10, 30), delayFor(5, 30), delayFor(10, 150), delayFor(1, 30), delayFor(0, 30)]).toEqual([70, 170, 0, 970, undefined])
})
```

- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: `terminal.test.tsx` fails to load (no `./terminal`).
- [ ] **Step 3: Implement `hooks/terminal.ts`.**
- [ ] **Step 4: Run the whole suite.** Run `claude plugin test .`. Expected: all pass.
- [ ] **Step 5: Commit:** `git add hooks/terminal.ts hooks/terminal.test.tsx && git commit -m "Size the terminal map and decide when pictures work"`

### Task 11: The terminal pane, the frame loop, the theme, the option and stats

**Files:**
- Modify:
  - `hooks/register.tsx` (the Pane `ui.render` hook, the `lot-map` command, a new `config.set` hook);
  - `hooks/map.ts` (`Setup.terminal`, `setupFrom`);
  - `hooks/text.ts` (one new string per language: the `stats` command's lines);
  - `.claude-plugin/plugin.json` (the option).
- Test: `hooks/terminal.test.tsx`

**Interfaces:**
- Consumes:
  - `sceneOf` (Task 6);
  - `paintScene`, `LayerCache`, `PICTURE` (Task 8);
  - `motionAt`, `changedAt` (Task 9);
  - `ringBox`, `PictureGate`, `delayFor` (Task 10).
- Produces:
  - `Setup.terminal: 'picture' | 'text'`; anything but `'text'` reads as `'picture'`;
  - the `userConfig` field `terminal`: `{ "type": "string", "title": "In the terminal", "options": ["picture", "text"], "default": "picture", "description": "How the map shows in a terminal: as a picture where the terminal can draw one (iTerm2 3.5 or later, kitty, Ghostty, in fullscreen), or as text." }`;
  - `/lot-map stats`: answers `{ text }` with the frame ms (average and p95 over the last 100 frames), the fps now, and blits taken and refused. Plain `/lot-map` still opens the pane.
- **Module state** (no `$` in it):
  - the latest board, box, theme row and `light`;
  - the current `Scene` and `LayerCache`;
  - the last frame string and the last frame ms (`performance.now()`);
  - a `PictureGate`;
  - a frame timing ring for stats;
  - `chainAlive: boolean` and a `generation` number.
- **Picture mode** applies on the terminal surface with option `picture`, a docked pane, a `ringBox`, and `gate.showsPicture()`. Then the render hook:
  1. Reads the theme row the first time it runs (`$.config.list()`), so a hot reload re-reads it.
  2. Records the board, box and `light`, where `light = setup.theme === 'auto' && themeRow.startsWith('light')`. A change of board identity drops the scene and cache. A change of box or `light` also drops the last frame.
  3. Paints a frame only when none exists or the box changed. A paint that throws draws the text view for this render.
  4. Returns `<Box flexDirection="column">`, holding:
     - `<Box justifyContent="center"><Image key="map" source={{ rgba: lastFrame, width: PICTURE.width, height: PICTURE.height }} columns rows alt={`${t.title}. ${describeNow(state, t)}`} /></Box>`;
     - the "now" Text;
     - the feed Texts, cut to `bodyRows − rows − 1`.

     Every Text has `wrap="truncate-end"`, and there is no tally line.
  5. If `!chainAlive`, or the gate asks for a probe, starts a chain with a `$.clock.after(0, tick)` closure written in the render hook. `generation` changes only on unmount, hot reload or a switch to text, and a tick whose generation is stale ends.
- **A tick** (inside `quietly`):
  1. Paints for `await $.clock.now()` and records the frame ms.
  2. Blits `{ requestId: 'lot-map', key: 'map', source: { rgba, width, height } }`.
  3. Acts on the result:
     - **accepted** → `gate.accepted`;
     - **refused** → `gate.refused`, then by its `next`:
       - `retry` → `after(inMs)`;
       - `text` → `generation++`, `chainAlive = false`, `$.ui.invalidate('ui.render')`;
       - `sleep` → `chainAlive = false`;
       - `carry-on` → go on;
     - **thrown** → `chainAlive = false`.
  4. Otherwise sets the next delay from `delayFor(motionAt(scene, now, changedAt(board)).fps, frameMs)`. When fps turns 0, it blits one last frame at that moment, then sleeps until `wakeAt` (`after(wakeAt − now)`) or the next render.
- **Theme changes.** A `config.set` hook on `{ key: 'theme' }` awaits `next`, re-reads the row, and calls `$.ui.invalidate('ui.render')`.
- **Everything else** (option `text`, inline, too small, no pictures, other surfaces) draws exactly today's tree, and no chain runs.

- [ ] **Step 1: Write the failing tests,** appended to `hooks/terminal.test.tsx` (its imports are already at the top):

```ts
const DOCK = { title: 'Map', isFocused: false, bodyColumns: 89, placement: 'dock', scroll: { offset: 0, bodyRows: 34 }, view: {} } as const
const PANE = { plugin: 'lot-map', component: 'Pane', requestId: 'lot-map', props: DOCK } as const
const themeRow = (value: string) => [{ key: 'theme', label: 'Theme', kind: 'choice', value, provider: { kind: 'engine' }, isLocked: false }]

const world = (on: On, blit: () => { deny?: string } = () => ({}), theme = 'dark') => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const blits: number[] = []
  on('ui.blit', () => { blits.push(clock.now()); return { value: blit() } })
  on('config.list', () => ({ value: themeRow(theme) }))
  on('tool.call', () => ({ result: {} }))
  return { clock, blits }
}
const stations = ['Read', 'Bash'] as const

test('the terminal pane shows the map as a picture with the feed cut to fit below it, at any height', async ($, on) => {
  world(on)
  for (let k = 0; k < 20; k++) {
    if (k % 2 === 0) await $.tool.call({ tool: 'Read', file_path: `/a/${k}/${'p'.repeat(120)}.ts` })
    else await $.tool.call({ tool: 'Bash', command: 'true', description: `${k} ${'x'.repeat(200)}` })
  }
  for (const [bodyRows, rows, columns] of [[34, 20, 45], [20, 12, 27], [60, 36, 81]] as const) {
    const ui = await $.ui.mount({ ...PANE, props: { ...DOCK, scroll: { offset: 0, bodyRows } }, surface: 'terminal' })
    expect((await ui.find({ type: 'Image' }))?.props).toMatchObject({ key: 'map', columns, rows })
    const texts = await ui.findAll({ type: 'Text' })
    for (const t of texts) expect(t.props.wrap).toBe('truncate-end')
    // The "now" line plus the feed, which holds at most 16 rows (foldRows).
    expect(texts.length).toBe(Math.min(bodyRows - rows, 1 + 16))
    await ui.unmount()
  }
})

test('a short pane and an inline pane draw todays text view', async ($, on) => {
  world(on)
  for (const props of [{ ...DOCK, scroll: { offset: 0, bodyRows: 19 } }, { ...DOCK, placement: 'inline' }]) {
    const ui = await $.ui.mount({ ...PANE, props, surface: 'terminal' } as never)
    expect(await ui.find({ type: 'Image' })).toBeUndefined()
    await ui.unmount()
  }
})

test('with terminal set to text the pane draws todays text view', { options: { terminal: 'text' } }, async ($, on) => {
  const { blits } = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(blits.length).toBe(0)
})

test('the loop runs at 10 while a pulse flies, paints a last frame, and stops once the map is still', async ($, on) => {
  const { clock, blits } = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const start = clock.now()
  await $.tool.call({ tool: 'Read', file_path: '/a/b.ts' })
  const from = blits.length
  await clock.advance(1000)
  expect(blits.length - from).toBeGreaterThanOrEqual(9)
  await clock.advance(120_000)
  expect(blits[blits.length - 1]!).toBeGreaterThanOrEqual(start + 1250)
  const quiet = blits.length
  await clock.advance(5000)
  expect(blits.length).toBe(quiet)
  await ui.unmount()
})

test('after two alt refusals the pane shows text by itself, and a minute later tries the picture again', async ($, on) => {
  const { clock } = world(on, () => ({ deny: 'the Image draws its alt here: this terminal draws no images' }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(2500)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await clock.advance(61_000)
  await ui.redraw()
  expect(await ui.find({ type: 'Image' })).toBeDefined()
})

test('desktop still gets the Svg and no blits are sent for it', async ($, on) => {
  const { clock, blits } = world(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(1000)
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  expect(blits.length).toBe(0)
})

const coreAt = (rgba: string): number[] => {
  const px = Uint8Array.fromBase64(rgba)
  const i = (Math.round(182 * 1.6) * 736 + Math.round(230 * 1.6)) * 4
  return [px[i]!, px[i + 1]!, px[i + 2]!]
}

test('with Claude Code on a light theme and the map on auto the frame is light, and a theme change repaints', async ($, on) => {
  let theme = 'light'
  mock.clock(on, { now: 1_000_000 })
  on('config.list', () => ({ value: themeRow(theme) }))
  on('config.set', (_, e) => { theme = String(e.value); return { value: e.value } })
  on('ui.blit', () => ({ value: {} }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(coreAt(((await ui.find({ type: 'Image' }))!.props.source as { rgba: string }).rgba)).toEqual([255, 255, 255])
  await $.config.set({ key: 'theme', value: 'dark' })
  expect(coreAt(((await ui.find({ type: 'Image' }))!.props.source as { rgba: string }).rgba)).toEqual([18, 21, 28])
})
```

  Where the kit's field names differ (the `config.set` input, the row shape), adjust the names but keep each assertion. If Task 4 changed `PICTURE.scale`, use `PICTURE` in `coreAt`.
- [ ] **Step 2: Run them to verify they fail.** Run `claude plugin test . 2>&1 | grep -E "\((pass|fail)\)"`. Expected: the seven new tests fail, and the five Task 10 tests still pass.
- [ ] **Step 3: Add the option.** Add `terminal` to `Setup`, `setupFrom` and `plugin.json`.
- [ ] **Step 4: Implement the rest in `hooks/register.tsx`:** the pane, the loop, the theme reading, the `config.set` hook and `/lot-map stats`, as described. If Task 4 found that timers from a render's `$` don't run, start chains from the board-changing hooks as Task 4's gate says.
- [ ] **Step 5: Run the whole suite and validate.** Run `claude plugin test . && claude plugin validate .`. Expected: all tests pass, the 42 originals included, and `✔ Validation passed`.
- [ ] **Step 6: Commit:** `git add hooks .claude-plugin/plugin.json && git commit -m "Draw the map as a moving picture in the terminal pane"`

### Task 12: Documentation, version, the person's check, cleanup

**Files:**
- Modify: `README.md`, `.claude-plugin/plugin.json` (version), `.claude-plugin/marketplace.json` (version, if it carries one).
- Delete: the `ring-test` mod folder.

- [ ] **Step 1: Update `README.md`.**
  - **Install, line 25:** replace "draws text only" with where the picture shows and where text stays.
  - **Options table:** add `terminal`.
  - **Colours:** note that in a terminal, theme `auto` follows Claude Code's own theme (`auto (match terminal)` and custom themes read as dark; set `theme` to `light` to force it).
  - **"What it shows and what it keeps":** add that it reads Claude Code's `theme` setting.
  - **Font:** give the font, its licence and its data size (`wc -c hooks/paint/font-data.ts`).
  - **Commands:** mention `/lot-map stats`.
- [ ] **Step 2: Set the version.** Set `"version": "0.4.0"`, then run `claude plugin validate .`. Expected: `✔ Validation passed`.
- [ ] **Step 3: The person's check.** They disable the installed lot-map in `/plugin`, then start `claude --plugin-dir /Users/froch/Development/claude/lot-map` in iTerm2, fullscreen, with the pane docked, and do a five-minute working turn. They check:
  - the map draws and moves, with text legible beside the terminal's own;
  - no typing lag;
  - `/lot-map stats` shows an average frame ms of 20 or less;
  - CPU of `claude` and iTerm2 in Activity Monitor during the turn, and zero once the route has faded;
  - a shrunk pane and `terminal: text` in `/config` both give the text view;
  - the desktop app shows the map as before.

  Record the numbers under the spec's Done means, and re-enable the installed lot-map if they want it back. A frame ms over 20 goes back to the person with Task 4's options.
- [ ] **Step 4: Final checks.** Run `bun scripts/golden.ts check && claude plugin test . && claude plugin validate .`. Expected: `0 mismatches`, all pass, validation passed.
- [ ] **Step 5: Clean up.** Delete `/Users/froch/.claude/dev-mods/4e805010-94ea-4bde-a455-ed356869fa4a/ring-test`.
- [ ] **Step 6: Commit:** `git add README.md .claude-plugin docs/superpowers/specs/2026-11-12-terminal-ring-design.md && git commit -m "Describe the terminal map, version 0.4.0"`

# The map in the terminal: design

Date: 2026-11-12 · Status: draft for approval (revised after a second adversarial review)

## Intent

lot-map draws its ring (the core with the context ring, ten stations with icons, labels and counts, spokes, the route, pulses) only on desktop, VS Code and mobile, because the terminal has no `Svg` element. In the terminal the pane shows text only (`hooks/register.tsx`, the `ui.render` hook: `if (e.surface === 'terminal') return …`). The person runs Claude Code in iTerm2 and wants the same ring there, drawn well. Braille on a `Raster` was mocked and rejected as ugly. The ring is to be drawn as real pixels with the terminal's `Image` element.

It is for the person's own use first. If it turns out well it may be contributed upstream to lot-map, so it is built to that standard from the start.

## Goals

- In a fullscreen terminal that can draw pictures (iTerm2 3.5+, kitty, Ghostty), the docked lot-map pane shows the ring as desktop draws it: same layout, colours, options, labels and languages, with motion.
- Motion budget:
  - 10 frames a second while something moves across the map;
  - 5 while only slow changes run;
  - nothing while nothing changes.
- Everywhere else, the pane shows today's text view by itself: a terminal that cannot draw pictures, the inline pane outside fullscreen, or a pane too small.
- Desktop, VS Code and mobile output is unchanged, byte for byte.

## Non-goals

- Braille or block-character drawing on `Raster`.
- Changing how the map looks on desktop.
- Faster paths for kitty or Ghostty (file or shared-memory sources). They get the same byte frames iTerm2 gets.
- Pointer or keyboard interaction with the picture.
- Fixing desktop's handling of subagents that never report back (see Motion: the cap).

## Anti-goals (would make it a failure even if it works)

- CPU spent while nothing on the map changes.
- The picture vanishing because the pane's content grew past its visible rows (see Constraints).
- Any change to the desktop drawing.
- Depending on anything only the person's machine has: no `rsvg-convert`, no processes, no files. The README promises the mod "makes no network requests, reads no files, runs no processes"; that stays true. Reading Claude Code's `theme` setting through `$.config.list()` is new and is said in the README.
- Typing lag in the prompt caused by drawing.

## Constraints and facts

Found in the API types for 2.1.322 (`claude-code.d.ts`), confirmed in the engine by two adversarial reviews, and measured by a throwaway test mod in the person's docked iTerm2 pane. Claude Code has since updated to 2.1.323. The alt-refusal text and the theme list were rechecked there; nothing else was.

- **Elements.** The terminal has `Image` and `Raster`, no `Svg`.
- **iTerm2 takes bytes only.** `{ png }` or `{ rgba, width, height }` base64, at most 2 MiB decoded (the engine checks `width × height × 4`); rgba sides 1–2048. File and shm sources draw the alt on iTerm2. The engine compresses rgba to PNG itself.
- **Every swap resends the whole picture on iTerm2.** The engine writes a full OSC 1337 inline image with `preserveAspectRatio=1` each frame. A wrong guess at the cell ratio letterboxes rather than squashes. kitty and Ghostty may stretch (unverified).
- **A partly hidden picture draws nothing on iTerm2.** The tree must never exceed the pane's visible rows. Text rows wrap by default (a label may run to 120 characters), so every Text below the picture must be truncated to one row (`wrap="truncate-end"`).
- **A render that returns the same `source` string sends nothing.** The engine keeps the last blitted picture shown. A render that returns a new source replaces it.
- **Renders are frequent.** `ui.render` re-runs "on a write of `$.state` it read while drawn, at the redraw rate" (up to 30 a second), which is at least twice per tool call.
- **Rates.** `$.ui.blit` takes up to 120 a second and shows about 60; a blit cannot change the Image's size; a resize is a redraw.
- **Timers drift.** `$.clock.every` asks for the next period after `fn` runs: asking for 10 fps gave 8, and 20 gave 14. A hot reload cancels pending timers.
- **`$` cannot be stored or passed.** Every engine call is spelled `$.noun.method(...)` inside a hook or a closure in it (enforced by `claude plugin validate`).
- **Runtime.** No DOM, no Node, no `CompressionStream`; `Uint8Array.prototype.toBase64` exists. Plugin code ran about 4× slower than under bun.
- **Measured in the person's pane** (Claude Code 2.1.322, iTerm2 3.7.7, fullscreen; pane 89×34 docked, viewport 114×44). A text-less test frame of 724×676 px with one opaque base layer:
  - about 13 ms to draw and base64 in the plugin, and about 11 ms for the blit to resolve;
  - 640 frames, none refused;
  - picture box 45×20 cells, about 16×34 screen pixels per cell;
  - the `theme` row of `$.config.list()` read `"dark"`.

  The person judged 10 fps the right rate. CPU and typing lag were not measured.
- **Refusals.** `UiBlitResult.deny` is free text. Every case where the Image shows its alt starts `the Image draws its alt here:`, and the tmux case also carries `fix: 'tmux-passthrough'`. The alt case can also come back briefly while the engine is still asking the terminal what it supports (slow start, ssh). A blit fired before the tree mounts is refused with `no Image of its own is mounted under key …`.
- **Theme values.** Claude Code's `theme` row holds:
  - `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`;
  - `auto` ("Auto (match terminal)");
  - or a custom theme's name.

## Approaches considered

- **A. One description of the map, two painters (chosen by the person).** Split `drawMap` into a scene: every shape with its paint and animations. One painter writes today's SVG from it; the other paints pixels for any moment. The scene also tells the scheduler what moves and until when. It is the largest change to `hooks/map.ts`, but desktop is protected by a golden test and the two outputs cannot drift.
- **B. The terminal reads the SVG.** Parse `drawMap`'s output, evaluate SMIL at time t, paint. Rejected: it reproduces every SVG and CSS trick through string parsing, and cannot easily tell the scheduler what moves.
- **C. A separate terminal drawing.** Rejected: every map change would be made twice, and upstream changes often.

## The design

### Scene and painters (decided: approach A)

- `drawMap(board, now, setup)` keeps its signature and output. It becomes `toSvg(sceneOf(board, now, setup), setup)`.
- **The scene keeps today's strings.** Byte-identical output is only realistic this way: today's literals mix forms (`opacity=".16"`, `dur=".5s"` beside `clock()`'s `"0.800s"`), and attribute order varies by call site. So each scene element carries its SVG tag and attributes in today's order and formatting, and the SVG painter only joins them. Begins stay relative to the scene's `now`, as today. The pixel painter reads the numbers it needs from those attributes and adds `now` to the begins.
- **Each element also carries what the terminal needs:**
  - its z-position in today's order;
  - its motion class (below);
  - whether it is the resting breath;
  - whether it is static (unchanged until the next board change).
- **The SVG painter** emits the light-theme CSS rules for theme `auto` exactly as now.
- **The pixel painter** evaluates each animation at an absolute time t and paints into an RGBA buffer with anti-aliasing. Everything `drawMap` uses:
  - **Shapes:** a rounded rect (`rx="12"`; its corners are transparent even with `solid`); filled and stroked circles; ellipses; lines; quadratic curves (the route).
  - **Icon paths:** the subset `STATIONS` uses (M, L, H, V, C, A, Z, relative forms), with round caps and joins.
  - **Dashes:** dashed ellipses (no `pathLength`), dashed lines, and partial strokes:
    - over `pathLength="1"` with a dash offset: clock hands under `rotate(-90)`, and the newest route leg;
    - over `pathLength="100"` with a dash array: the context ring.
  - **Text:**
    - `text-anchor="middle"` with `letter-spacing` (the core name);
    - tspans with their own fill (memory's `↓`);
    - `font-weight="700"` (the fault count);
    - rims drawn first as a round-joined stroke in the ground's colour (`paint-order="stroke"`, width 3.5 before scaling).
  - **Animations:**
    - `animate` with values and keyTimes;
    - two opacity animations on one element (the later begin wins once it starts);
    - a frozen value after an integer `repeatCount` (switch rings);
    - `animateMotion` along a line (pulses);
    - `animateTransform` rotate (crew dots, inside a `g`).
- **Last frame.** When a motion ends, the loop paints one frame at or after its end, so nothing is left mid-flight.

### Motion classes (rule decided here; budget decided by the person)

The rule:

- **Fast (10 fps):** finite animations that move geometry (a position, a radius, a dash): pulses and their tails, ripples, the newest route leg drawing itself, switch rings, the answer ring, and the route end dot fading in.
- **Slow (5 fps):** the never-ending loops, as the person decided: the core's breath, a running station's spreading ring, the clock hands and the crew dots. Also opacity-only fades of 1.6 s or longer: glows, the cooling ring, beams, alarm fades, the route's 20-second fade. The outer hand counts as slow even though it is finite (600 s); it moves too slowly for more.
- **Still (0 fps):** when nothing changes, including the route's 40-second hold.

Notes on the rule:

- **The breath.** When nothing runs, the core does not breathe in the terminal (my call). The painter draws the breath element at its resting value: the animation's smallest radius and opacity (CORE+3, .05), not the SVG's static attributes. Desktop always breathes.
- **Expected cost while Claude works (my estimate).** A working turn always has something running: a model step counts as a running call on Model. So the map is at 5 fps for the whole turn, with a 10 fps burst of about 1.25 s after each event. At about 25 ms per frame, that's roughly an eighth of one core, plus the bursts. Nothing while Claude waits for you. To be measured (see Done means).
- **The cap (my call).** If the board has not changed for 5 minutes, the loop drops to 1 fps until the next change. This bounds the cost of a subagent that never reported back: its dots and `run` entries stay on the board, since only a subagent's own `turn.complete` clears them, and they would otherwise animate forever. It also covers a call that hangs. The board data is left alone, because a background subagent may legitimately outlive the main turn.

### Frame loop (my calls)

- **Only the loop paints.** The render hook returns the last painted frame's string unchanged, so the engine sends nothing on a render. It also marks the scene dirty and wakes the loop. It paints in the render only when there is no frame yet, or when the Image's size changed.
- **The loop** is a chain of `$.clock.after` calls. Each delay is the interval minus the time the last frame took. Each frame is painted for `$.clock.now()` and blitted to the keyed Image, one at a time.
- **Scene and cache.** When the board changed, the loop rebuilds the scene and the static layers once, then paints. The static layers sit between animated elements in z-order (the node disc under the cooling ring under the icon and label; the core between the breath and the switch rings). They are cached as premultiplied layers and composited within their bounding boxes.
- **Frame budget:** at most 20 ms per frame in the plugin at full size, including text, with two stations cooling and one running. Measured early (see Build order).
- **Surfaces and stops.** The loop runs only for the terminal surface. It sleeps when the motion query says still and wakes at the next scheduled change or render. A "not mounted" refusal is retried three times with backoff (100, 300, 900 ms), then the loop sleeps until the next render.

### Picture size and layout (layout B, chosen by the person)

- **Picture size.** 1.6× the 460×430 viewBox: 736×688 px, which is 2,025,472 bytes, inside the 2 MiB cap.
- **The tree, top to bottom:**
  1. the picture, centred;
  2. the "now" line;
  3. the feed.

  Every Text is truncated to one row, and the feed gets the rows that remain. The tree never exceeds `bodyRows`.
- **No tally line in picture mode.** The counts are on the map.
- **Ring size:**
  - rows `R = floor(bodyRows × 0.6)`;
  - columns `C = round(R × 2.1 × 460/430)`;
  - if `C > bodyColumns`, then `C = bodyColumns` and `R = floor(C / (2.1 × 460/430))`.
- **Text view** when `R < 12`, when the placement is `inline`, while the terminal is known not to draw pictures, or when the option says `text`.

### Pictures supported or not (my calls)

- **Pictures work** once any blit is accepted. No more probing until a render follows a refusal.
- **Probe.** After the first render, and after a render that follows a refusal, the loop sends the current frame as a probe blit.
- **No pictures.** The first alt refusal (`the Image draws its alt here:`) schedules a second probe 2 s later. A second alt refusal at least 2 s after the first, with no blit ever accepted, switches the pane to the text view. It is not permanent: the next render at least 60 s later shows the picture again and probes. A slow start or an ssh session therefore recovers.
- Other refusals never switch modes.
- Today's text view is unchanged.

### Theme, background, colours (my calls)

- **Theme `auto`** follows Claude Code's `theme` row: a value starting with `light` gives the light palette. `dark…`, `auto` (whose terminal colour the plugin cannot see), a custom theme or no row give dark. The README says so and names `theme: light` as the way to force light. The row is read at session start and on each config change.
- **Background.** `solid` stays the default. `transparent` leaves the ground's pixels at alpha 0, and the label rims behave as the README describes for desktop.
- **Colours.** In auto-light the pixel painter applies exactly `lightRules`' remapping. Colours are remapped by value: each dark palette value maps to its light value, skipping a key the person set and any key whose dark value equals one of the person's colours. This is not a plain palette swap.

### Font (decided after a still, as the first step of the build)

Decided (2026-11-12): outline — JetBrains Mono, compared in the docked iTerm2 pane against the stroke candidate. Label scale 1 (TEXT_SCALE).

**The candidates.** The build's first step paints the same still with each, in the docked pane beside real terminal text, and the person picks one:

1. Outlines from an open font, e.g. JetBrains Mono (SIL OFL 1.1), regular and bold, extracted by a development-time script into a generated data file. If chosen, ship the OFL text and state the data's size in the README.
2. A single-stroke font, painted with the line painter: Hershey Roman Simplex for Latin, each glyph centred in a fixed advance, with Cyrillic and `ä ö ü ß` drawn by hand. Bold is a wider stroke. For the checkpoint it covers only the still's text. Hershey's Cyrillic sets are double-stroked and don't match. If the person picks it, completing full coverage is extra work: composing accents, and drawing all of Cyrillic and `Ð Þ ß æ ø`.

**Coverage:** printable ASCII, Latin-1 letters, Cyrillic U+0400–U+045F, and `· × ↓ → … % +`. A missing character, which only a core name of one's own can bring, is a hollow box.

**Legibility is the real question.** At 1.6× the labels are about 18 px, counts 15 px, the percent 13 px and a ten-letter core name 13 px. The terminal's own text is about 27 px per em, so the map's text comes out at about half to two thirds of it, without hinting. A bigger pane only upscales the picture, and at the 12-row floor everything is about 0.6× of that.

The still is shown at the person's 34 body rows and also at 24 and 60. If labels read too small, the fallback is a terminal-only text scale on the map's labels, decided at that checkpoint.

### Option (my call; can change before upstream)

A new `userConfig` field, `terminal`: `picture` (default for the person) or `text` (today's view). Upstream is likely better served by `text` as the default.

`/lot-map stats` reports the frame ms (average and p95 over the last 100 frames), the current fps, and blits taken and refused. It is how the frame budget is checked in the real pane, and how a user can report a slow terminal.

## Build order and early checks

1. **Font and size still.** Painter primitives plus both font candidates; a still in the docked pane at 34, 24 and 60 rows. The person picks the font and judges label size.
2. **Frame cost and hidden-picture checks** in the real pane, before the refactor:
   - a full frame with text, two cooling stations and one running, against the 20 ms budget;
   - CPU of Claude Code and iTerm2 at 5 and 10 fps;
   - typing feel;
   - whether a height-only resize re-renders the pane;
   - whether re-showing a hidden tab re-runs the hook;
   - what the first probe at session start returns.
3. **Golden capture,** then the scene refactor of `drawMap` with the SVG painter.
4. **Pixel painter** on the scene; motion query; frame loop; fallback.
5. Option, README, version 0.4.0, cleanup.

## Tests

- **Golden desktop output.** A development script, run under bun, writes `drawMap` output for the matrix below before the refactor and diffs it after (a mismatch shows a real diff). The plugin test suite also holds a fixture module of hashes for the same matrix, since `claude plugin test` has no file system.
  - **Times either side of each threshold:** 1250 ms (pulse plus ripple), 1600, 3200, 6000, 8000 and each switch lap, 1100 (the answer ring), 40 s and 60 s (route hold and fade), clock hands before and after 600 s.
  - **Boards:**
    - lanes, and a hollow inbound pulse;
    - memory `pushed` with asked 0 and above 0;
    - ×n, and faults of 1 and over 99;
    - context absent, 0, 69, 70, 90 and 100;
    - no model;
    - crew of 3 and 6.
  - **Setups:** both themes plus auto; both layouts; both backgrounds; a colour equal to a dark palette value; all five languages; core names of 1, 3 and 10 characters, and one with `<&"`.
- **Timeline.** Each animation form at chosen times: before begin, during, after with and without freeze, integer repeat with freeze, keyTimes, two opacity animations on one element.
- **Painter.** Coverage at known pixels for each primitive, the rounded corners' alpha, a deterministic frame hash for a fixed board and time, and the picture size.
- **Motion query.** Fast, slow or still for boards at chosen times: a running call, the gap between calls, the route hold and fade, an idle core, and the 5-minute cap.
- **Pane on the terminal surface** (`$.ui.mount`; the test answers `ui.blit` and `config.list` itself; all timing through `$.clock` so the mock clock drives it):
  - an `Image` with its key while room allows;
  - every Text below it truncated;
  - total elements within `bodyRows` across a range of pane sizes;
  - the text view when the pane is small, inline, or set to `text`;
  - after two alt refusals, then the picture back after 60 s;
  - not after other refusals;
  - a not-mounted retry.
- **The existing tests stay green.**

## Done means

- In the person's docked iTerm2 pane the map draws and moves as described, its text is legible beside the terminal's own, and typing shows no lag.
- **Measured** over a five-minute working turn: CPU of Claude Code and of iTerm2 at the 10/5 mix; idle CPU zero once the route has faded and nothing runs.
- Desktop output is byte-identical (golden diff and hashes).
- `claude plugin test .` and `claude plugin validate .` pass.
- **README:**
  - line 25 ("draws text only") is replaced;
  - the options table has `terminal`;
  - the theme `auto` behaviour in the terminal is described;
  - the "What it shows and what it keeps" section mentions reading the `theme` setting;
  - the font's licence and size are given, if an open font is used.
- Version 0.4.0. The throwaway `ring-test` mod is deleted.

## Left to the builder

- The module split, and how scene elements are typed.
- The anti-aliasing method and how layers are composited.
- The path parser's internals.
- How font data is generated and stored.
- How the loop is woken.

## For upstream (later)

- Default `terminal` to `text`.
- Keep this design document out of the pull request.
- State the font data's size and licence.
- Expect questions about the change's size (the plugin is about 2,100 lines today) and about testing on kitty and Ghostty.

## Known gaps

- kitty and Ghostty are untested; they may stretch the picture to the cell box.
- A height-only resize may not redraw. If the pane shrinks, the picture may be partly hidden and vanish until the next redraw (checked in step 2).
- The cell ratio 2.1 is a guess that held for the person's font; another font letterboxes slightly on iTerm2.

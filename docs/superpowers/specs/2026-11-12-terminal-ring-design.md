# The map in the terminal: design

Date: 2026-11-12 · Status: revision 2 for approval (after measurements in the person's iTerm2 and Ghostty panes and a shared-memory spike)

## Intent

lot-map draws its ring (the core with the context ring, ten stations with icons, labels and counts, spokes, the route, pulses) only on desktop, VS Code and mobile, because the terminal has no `Svg` element. In the terminal the pane shows text only (`hooks/register.tsx`, the `ui.render` hook: `if (e.surface === 'terminal') return …`).

The person wants the same ring in the terminal, drawn as real pixels, with **smooth** animation. Braille on a `Raster` was mocked and rejected as ugly. Sending frames as bytes through the plugin was measured and rejected (see Constraints). The ring is drawn by a helper process into POSIX shared memory, and the terminal's `Image` element shows each frame by name.

It is for the person's own use first. If it turns out well it may be contributed upstream to lot-map, so it is built to that standard from the start, with the picture off by default there.

## Goals

- In a local, fullscreen terminal that reads shared-memory frames (Ghostty, kitty), the docked lot-map pane shows the ring as desktop draws it: same layout, colours, options, labels and languages. It moves smoothly.
- Motion:
  - 20 frames a second while something moves across the map;
  - 15 while only the never-ending loops run;
  - nothing while nothing changes;
  - 1 a second once the board has not changed for 5 minutes.
- Typing in the prompt stays as fast as without the map.
- Everywhere else the pane shows today's text view by itself: iTerm2, tmux, ssh, VS Code's terminal, Terminal.app, the inline pane outside fullscreen, a pane too small, or no `bun` on the machine.
- Desktop, VS Code and mobile output is unchanged, byte for byte.

## Non-goals

- A picture in iTerm2. It keeps every inline image it receives (see Constraints).
- Frames sent as bytes through the plugin API.
- Braille or block-character drawing on `Raster`.
- Changing how the map looks on desktop.
- Pointer or keyboard interaction with the picture.
- Fixing desktop's handling of subagents that never report back (see the cap under Motion).

## Anti-goals (would make it a failure even if it works)

- **Frames written to disk.** The person ruled it out: frames live in shared memory only.
- **CPU spent while nothing on the map changes.**
- **A stutter at every event,** where the frame after a board change misses its slot.
- **Typing lag** in the prompt.
- **The picture vanishing** because the pane's content grew past its visible rows.
- **Leaked shared memory** that outlives the session.
- **Any change to the desktop drawing.**

## Constraints and facts

From the API types (2.1.322; Claude Code has since updated to 2.1.323), the engine's code, and measurements in the person's panes (iTerm2 3.7.7; Ghostty; fullscreen, docked).

**Delivery by bytes, measured and rejected:**
- **iTerm2 retains every frame.** Its memory footprint grew from 4.4 GB to 10 GB over about 8,900 frames, about 0.6 MB per frame, and it did not fall after the frames stopped. iTerm2 accepts only byte sources, so no change in the plugin avoids this.
- **Ghostty stalls on byte frames.** Each frame is about 2.7 MB of base64 through the terminal stream, and the engine's work per frame runs on Claude Code's thread. At 20 fps the person saw flicker, a choppy picture and "painfully slow" typing. Claude Code used 36–53% of a core.
- **Painting cost.** In the plugin runtime a cached frame took about 8 ms to paint and 11 ms to blit. A full uncached still with all labels took 128 ms.

**Delivery by shared memory, measured in the spike and adopted:**
- **The source.** `{ shm: name, format: 'rgba', width, height }`. The terminal opens, reads and decodes the object itself, then unlinks it, so each name feeds one frame. Names are `/` plus up to 254 of `A-Z a-z 0-9 . _ -`, and macOS takes 30 characters. It works only when Claude Code and the terminal share a machine: not through tmux, not over ssh. A blit swaps the keyed Image with one small command.
- **The helper.** A `bun` process paints the frames and creates each object through a C shim compiled at start with `bun:ffi`'s `cc` (shm_open is variadic, so it is called from C). Mode 0600 arrives correctly.
- **Measured in Ghostty:**

  | | 20 fps | 30 fps |
  | --- | --- | --- |
  | Frames taken | 19.8 fps | 29.8 fps |
  | Blit, on Claude Code's side | 0.6 ms | 0.5 ms |
  | Helper paint per frame | 8.6 ms | 6.6 ms |
  | Helper shared-memory write | 0.33 ms | 0.33 ms |
  | Helper skips (Ghostty behind) | — | 3 in ~1,350 |

  CPU at 30 fps: helper 22–27% of a core (28 MB), Claude Code about 3%, Ghostty about 6% with flat memory. The person: "felt good".
- **One refusal at start-up:** `the terminal has not yet said whether it reads files on this machine; asked now, blit again`. It is transient and must be retried.
- **macOS page rounding.** It reports the object's size rounded up to a page (2,031,616 bytes for 2,025,472). Ghostty drew the frames regardless.

**Plugin API:**
- **`$.process.spawn({ argv, cwd, env, input })`** starts a child for as long as the loop reading its stdout runs. Leaving the loop, `return()`, or the module unloading kills it. `input` is written once and stdin then closes.
- **`$.fs.write(path, text)`** writes UTF-8 text only. Nothing documents in-place writes, so a named pipe is not dependable.
- **`$.http.fetch(url, { method, headers, body, socketPath })`** can go over a Unix socket. An organisation's web-fetch policy may refuse it, in which case the pane falls back to text.
- **Elements.** The terminal has `Image` and `Raster`, no `Svg`. A partly hidden picture may draw nothing, so the tree must never exceed the pane's visible rows, and every Text below the picture is cut to one row (`wrap="truncate-end"`).
- **Renders are frequent.** `ui.render` re-runs on each write of state it read, up to 30 a second, which is at least twice per tool call. A render that returns the same `source` sends nothing. A shm name "is never sent again on a redraw".
- **Timers from a render hook's `$` run.** A 100 ms chain and a 40 s wait both ran.
- **`$` is never stored or passed** (`claude plugin validate`).
- **Refusals.** `deny` is free text:
  - every alt case starts `the Image draws its alt here:`, and the tmux case also carries `fix: 'tmux-passthrough'`;
  - not mounted starts `no Image of its own is mounted`;
  - the start-up capability message is quoted above.
- **Theme values:** `dark`, `light`, `dark-daltonized`, `light-daltonized`, `dark-ansi`, `light-ansi`, `auto` ("Auto (match terminal)"), or a custom theme's name.

## Approaches considered

**Drawing.**
- **A. One description of the map, two painters (chosen).** `drawMap` is split into a scene that keeps today's exact SVG strings. Desktop joins them; the pixel painter samples each animation at a moment.
- **B. Parse the SVG back.** Rejected as fragile.
- **C. A separate terminal drawing.** Rejected because it would drift from desktop.

**Delivery.**
- **Bytes through the plugin.** Rejected after measurement: iTerm2 leaks, and Ghostty flickers and lags.
- **Temporary files read by the terminal.** Ruled out by the person: no disk I/O for frames.
- **Shared memory from a helper process (chosen).** Smooth at 20–30 fps, with about 3% of Claude Code's time.

**Board to helper.**
- **A named pipe through `$.fs.write`.** Undocumented behaviour, so rejected.
- **A small file per change.** Disk I/O, so rejected.
- **A local Unix socket through `$.http.fetch({ socketPath })` (chosen).** In memory and documented.

## The design

### Scene and painters (decided: approach A; unchanged)

- `drawMap(board, now, setup)` keeps its signature and output. It becomes `toSvg(sceneOf(board, now, setup))`.
- **The scene keeps today's strings.** Each element carries its SVG tag and attributes in today's order and formatting, plus:
  - its motion class;
  - whether it is the resting breath;
  - an identity for caching (below).

  Begins stay relative to the scene's `now`. The SVG painter only joins strings and emits the light-theme CSS for `auto` exactly as now.
- **The pixel painter** samples each animation at an absolute time t and paints with anti-aliasing. It covers everything `drawMap` uses:
  - **Shapes:** the rounded background rect (transparent corners), circles, ellipses, lines, quadratic curves.
  - **Icon paths:** M L H V C S Q A Z and their relative forms, with round caps and joins.
  - **Dashes:** dashed ellipses and lines; partial strokes over `pathLength` 1 (hands, the newest route leg) and 100 (the context ring).
  - **Text:** middle anchoring with letter-spacing, tspans with their own fill, bold, and rims under the letters.
  - **Animations:** `animate` with values and keyTimes; two opacity animations on one element; a frozen value after an integer `repeatCount`; `animateMotion` along a line; `animateTransform` rotate.
- **Last frame.** When a motion ends, one frame is painted at or after its end.

### Caching per station, so events don't stutter (new)

- **What the painter caches.** It caches the unchanging parts as separate layers, each with its own key:
  - the background (ground and contours), which changes only with the theme, the background option or the size;
  - each station's spoke (its width follows the station's count);
  - each station's resting layer (node disc, icon, name, count, badges);
  - the core's resting layer (disc, name, model, percentage).
- **What a board change repaints.** Only layers whose key changed. A key is the strings of the nodes in that layer, so it changes exactly when the drawing would.
- **Elements with animations that aren't changing are cached too.** Before its begin, frozen after its end, or holding (the route's 40 s hold), an animated element is drawn into the cache with its current sampled values, which join the layer's key. Only elements whose values change at t are painted each frame. This keeps the route's long semi-transparent curves out of the per-frame work.
- **Budget,** measured in the helper under bun on the real busy map at R = 20 (727×680):
  - a frame with no board change paints in at most 7 ms on average;
  - the first frame after a typical change (one station's count and state) in at most 20 ms;
  - a frame that repaints every layer only at session start, a theme change or a resize.

  Cost grows with the picture's area, roughly ×2 at the 1000 px cap. This is checked before the helper is built (Build order step 3).

### Motion classes (rates decided by the person)

- **Fast, 20 fps:** finite animations that move geometry. Pulses and tails, ripples, the newest route leg drawing itself, switch rings, the answer ring, the route end dot fading in.
- **Slow, 15 fps:**
  - the never-ending loops: the breath, a running station's spreading ring, the clock hands, the crew dots;
  - opacity-only fades of 1.6 s or longer: glows, the cooling ring, beams, alarm fades, the route's 20 s fade;
  - the outer hand, which is finite but slow.
- **Still, 0 fps:** nothing changes, including the route's 40 s hold.
- **The cap:** after 300 000 ms without a board change, 1 fps. This bounds a subagent that never reported back, or a hung call.
- **The breath:** when nothing runs, the core rests at its first animation values (CORE+3, .05) and does not breathe. Desktop always breathes.
- **Expected cost while Claude works.** Something is always running during a turn, a model step at least, so the helper runs at 15 fps (about 12% of a core), with 20 fps bursts (about 18%) of about 1.25 s after each event. Claude Code's share is about 3%, and nothing runs while Claude waits for you.

### The helper

- **`helper/painter.ts`,** run as `bun helper/painter.ts <socket path> <session tag>`.
  - It lives outside `hooks/`, so the engine never loads it as a module.
  - It imports the scene, the pixel painter, the font and the motion query from `hooks/`.
  - Its tests are `helper/*.spec.ts`, run with `bun test helper`; `claude plugin test` only runs `*.test.ts(x)`.
- **Channel in: a Unix socket.** `Bun.serve({ unix })` at a path the plugin chooses: `<tmpdir>/lot-map-<session tag>/h.sock`.
  - `<tmpdir>` is `TMPDIR`, falling back to `/tmp` when the whole path would exceed 100 bytes. Claude Code's docs give "near 100 B at most… in a private directory".
  - The helper creates the directory 0700 and removes a stale socket before listening.
  - It prints `R` on stdout once it listens. The plugin sends nothing before `R`.

  Requests are JSON over POST:
  - `/setup`: the options, the light flag, the picture size;
  - `/board`: the board and the plugin's clock `now`;
  - `/pause` and `/resume`;
  - `/stats`: returns counters.

  The socket carries only these messages; no frame data passes through it or the disk.
- **Channel out: stdout lines.**
  - `R` once, when the socket listens;
  - `F <name> <width> <height> <generation>` for each frame. The generation, a running frame counter, is the ImageSource field that marks a reused name as a fresh object;
  - `S …` each second, with frames, paint ms, shm ms, unread count and skips;
  - `E <message>` for an error.
- **Frames.** A ring of 8 fixed names per session, `/lm-<session tag>-<k>` with the tag 8 characters (at most 30 in all). The tag is made once per session and kept in `$.state`, so it survives a plugin reload, and a restarted helper cleans its predecessor's ring.
  - **Creating:** a frame goes to the next name whose object is gone (the terminal unlinked it), via `O_EXCL`.
  - **Backpressure:** if all 8 are unread, the tick is skipped.
  - **Clean-up:** at start the helper unlinks all 8 names, so a crashed predecessor in the same session leaves nothing; at exit it unlinks what is unread; it also unlinks any of its frames still unread after 1 s.
  - **Parent death:** the helper never watches stdin, which `$.process.spawn` closes from the start. It exits on SIGTERM, SIGINT, SIGHUP or SIGPIPE, on an error writing stdout, or when a 2 s poll finds its parent gone (`process.ppid === 1`).
  - The C shim compiles at start with `bun:ffi` `cc`. If that fails, the helper prints `E` and exits, and the pane shows text.
- **The loop.**
  - Clocks (my call): the plugin and the helper share the machine's wall clock (`$.clock.now()` and `Date.now()`). The helper builds the scene with the posted `now` and samples it at `Date.now()`. Only when the two differ by more than 1 s (a test's mock clock) does it use the offset from the latest post, fixed per post, so a re-post with the same entries never makes a pulse jump.
  - It runs at the motion query's rate, drift-corrected.
  - It sleeps when still, and wakes at the next scheduled change or the next `/board`.
  - It applies the 5-minute cap from the board's change time.

### The plugin

- **Deciding picture mode up front (my call).** Before starting anything, the plugin reads the environment with `$.env.get`. Picture mode needs all of:
  - option `terminal` is `picture`;
  - the terminal is Ghostty or kitty: `TERM_PROGRAM` is `ghostty`, or `TERM` is `xterm-kitty`, or `KITTY_WINDOW_ID` is set;
  - none of `TMUX`, `ZELLIJ`, `STY` (GNU screen), `SSH_CONNECTION` or `SSH_TTY` is set;
  - the surface is the terminal, the placement is `dock`, and a ring box exists.

  Anything else (iTerm2, VS Code, Terminal.app, WezTerm, …) gets the text view with no helper started and no picture sent. An allow-list keeps iTerm2 from ever receiving a picture, which it would retain.
- **Starting.** When the terminal pane draws in picture mode, the plugin starts the helper once per session (`$.process.spawn`, argv `bun …`).
  - It finds `bun` on PATH, else at `~/.bun/bin/bun`.
  - It reads the stdout loop in a closure written in the hook, for the session's life.
  - No `bun`, or the helper exiting three times within a minute (restarts after 1 s and 5 s), gives the text view until the next session.
- **Feeding.**
  - `/setup` at start and on a theme or option change.
  - `/board` on each board change, at most 10 a second. A newer board replaces a pending one, because each post costs Claude Code's thread a little, and that cost is measured in the wiring step. Each post carries the plugin's `now` (`$.clock.now()`) and `changedAt`: the latest `startedAt`, `endedAt` or `switchedAt` on the board. Posting an identical board never moves `changedAt`, so the 5-minute cap still fires.
  - `/pause` when the pane is hidden or closed or a blit says not mounted; `/resume` on the next render.
- **First in the wiring step,** three things the spike did not exercise are checked in Ghostty, each with its fallback:
  - `$.http.fetch` over the socket reaches the bun server. If not, the pane shows text and the person is told.
  - A helper started from a render hook's closure survives the hook. If not, it is started from `session.start`'s closure, as the API's own example does.
  - Frames of a new pixel size after the 1×1 placeholder draw. If not, the placeholder is full size.
- **Relaying.** Each `F <name> <width> <height> <generation>` becomes `$.ui.blit({ requestId: 'lot-map', key: 'map', source: { shm: name, format: 'rgba', width, height, generation } })`, then:
  - **accepted:** pictures work;
  - **the start-up capability message:** retry the next frame;
  - **alt** (`the Image draws its alt here:`), twice at least 2 s apart with nothing accepted: text view, and the helper is stopped. A render 60 s later tries again.
  - **not mounted:** `/pause` until the next render.
  - **anything else:** carry on.
- **The render hook,** in picture mode:
  1. The picture, centred.
  2. The "now" Text, then the feed Texts, every Text cut to one row, the feed cut to fit `bodyRows`. There is no tally line.

  The Image is `<Image key="map" columns={C} rows={R} source={…} alt={title + now line} />`, centred in a Box. Its `source` is the last frame's shm source, which the engine does not resend. Before any frame exists it is a 1×1 rgba pixel of the ground colour, so the box shows the ground until the first frame lands.

  If Ghostty refuses or blanks shm frames whose pixel size differs from the mounted source's, the placeholder becomes a ground picture at the current picture size instead: one send of up to about 5.7 MB of base64 per session and per resize. This is checked first in the wiring step (my call).
- **Stats.** `/lot-map stats` reports:
  - the helper's state;
  - frames taken and refused, and the blit ms;
  - the helper's last `S` line;
  - the board posts.
- **Failures** never reach a tool call, a turn or the conversation; every call is wrapped as `register.tsx`'s `quietly` does.

### Picture size and layout (layout B, chosen by the person)

- **Picture size follows the pane (decided by the person).** Shared memory has no 2 MiB limit.
  - Height = `clamp(R × 34, 408, 1000)` px, where 34 px per row was measured on the person's Retina display.
  - Width = `round(height × 460 / 430)`.
  - Scale = `height / 430`.

  So R = 20 gives 727×680 (about today's 1.6×); the tallest gives 1070×1000. The helper repaints every layer when R changes. Frame bytes are `width × height × 4`, up to about 4.3 MB.
- **Ring box:**
  - `R = floor(bodyRows × 0.6)`;
  - `C = round(R × 2.1 × 460/430)`;
  - if `C > bodyColumns`, then `C = bodyColumns` and `R = floor(C / (2.1 × 460/430))`.
- **Text view** when `R < 12`, when the placement is `inline`, or when any condition under Goals applies.

### Theme, background, colours (my calls)

- **Theme `auto`** follows Claude Code's `theme` row: a value starting with `light` gives light; `dark…`, `auto`, a custom theme or no row give dark. The row is read on the first render and on each change, and sent to the helper in `/setup`.
- **Background.** `solid` stays the default; `transparent` leaves the ground at alpha 0.
- **Colours.** In auto-light, `lightRules`' remapping is applied exactly.

### Font (decided)

Decided (2026-11-12): outline, JetBrains Mono (SIL OFL 1.1), compared in the docked pane against a stroke candidate. Label scale 1 (`TEXT_SCALE`). The font covers ASCII, Latin-1, Cyrillic U+0400–U+045F and `· × ↓ → …`. A missing character is drawn as a hollow box.

### Option

- **`terminal`:** `picture` or `text`. This branch ships `picture` as the default (my call): the allow-list and the `bun` check keep everyone else on text anyway. A pull request upstream would flip it to `text`.
- **The README states what `picture` does:**
  - it starts a `bun` helper, uses shared memory and a local socket, and writes no frames to disk;
  - the board (names and labels, never contents) goes to the helper through Claude Code's request machinery, where another installed plugin that watches requests could see it.

  It also says what the mod reads: the `theme` setting.

## Build order

1. Done: rasteriser, font and text; the font chosen; timers, frame cost and delivery measured.
2. Golden capture, then the scene refactor and the SVG painter.
3. Timeline, then the pixel painter with per-station caching (budgets above, measured under bun), then the motion query (20/15/0/1).
4. Terminal layout and the picture gate.
5. The helper: shm shim and name ring, socket, loop, stdout protocol, with `bun test` specs.
6. Plugin wiring: spawn, feed, relay, render, theme, option, stats.
7. README, version 0.4.0, the person's check in Ghostty and iTerm2, cleanup.

## Tests

- **Golden desktop output:** 68 cases, hashes in the plugin suite, full diffs under bun.
- **Timeline, painter, motion query and layout:** in the plugin suite (`claude plugin test .`). These include the per-station cache, where a cached frame must equal an uncached one byte for byte, and only the changed station's layer may be repainted after a single-station change.
- **The helper,** with `bun test helper`:
  - the name ring and backpressure;
  - clean-up at start and exit;
  - socket messages;
  - the 20/15/0/1 schedule against a fake clock;
  - a frame written and read back through shared memory.
- **The pane,** with the plugin kit (`$.ui.mount`, `mock.clock`; the test answers `ui.blit`, `config.list`, `process.spawn` and `http.fetch`):
  - picture mode wiring;
  - relaying `F` lines to blits;
  - each refusal kind;
  - the text view in its cases;
  - rows within `bodyRows`.

## Done means

- **In the person's docked Ghostty pane:**
  - the map draws and moves smoothly, without visible stutter at events;
  - text is legible;
  - typing shows no lag.
- **Measured over a five-minute working turn:**
  - the helper about 15% or less of a core on average at R = 20 (it scales with picture area);
  - Claude Code about 5% or less;
  - Ghostty's memory flat;
  - idle CPU zero once the route has faded;
  - no `/lm-…` objects left after the session ends.
- **In iTerm2,** the pane shows the text view by itself.
- **Desktop output is byte-identical.**
- **Checks pass:** `claude plugin test .`, `bun test helper` and `claude plugin validate .`.
- **README:** updated (terminal note, the option, its requirements, what it reads).
- **Version 0.4.0.** The throwaway `ring-test` mod is deleted.

## Left to the builder

- The module split, and how scene elements are typed.
- The anti-aliasing method, and how cached layers are composited.
- The C shim's exact code.
- The socket message shapes beyond those named.
- How the stdout loop is woken.

## Known gaps

- kitty is untested; Ghostty is the reference. macOS reports a shm object's size rounded up to a page, and Ghostty draws the frames regardless. If kitty shows a blank box, the fix is a frame height that is a multiple of 128.
- A height-only resize may not redraw the pane.
- A helper killed with SIGKILL in another session leaves up to 8 frames (16 MB) until reboot. A helper in the same session cleans them at its next start.

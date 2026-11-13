// bun scripts/bench.ts: the pixel painter's frame times on the busy map, as the helper paints it (one frame every 50 ms).
// Budgets at pictureFor(20): a frame with no board change ≤ 7 ms on average, the first frame after a change ≤ 20 ms.
import { GOLDEN_CASES } from '../hooks/golden-cases'
import { setupFrom } from '../hooks/map'
import { LayerCache, paintScene, pictureFor } from '../hooks/paint/scene-paint'
import { sceneOf } from '../hooks/scene'

const FRAME_MS = 50
const WARM = 10
const FRAMES = 40
const MORE_CHANGES = 5

const busy = GOLDEN_CASES.find(g => g.name === 'busy-default')!
const setup = setupFrom(busy.options)
const options = { light: false, colors: setup.colors }
const ms = (v: number) => `${v.toFixed(2)} ms`

for (const rows of [20, 40]) {
  const picture = pictureFor(rows)
  const cache = new LayerCache(picture, options)
  let board = busy.board
  const scene = sceneOf(board, busy.now, setup)
  let t = busy.now
  for (let k = 0; k < WARM; k++, t += FRAME_MS) paintScene(scene, t, picture, options, cache)

  let total = 0
  let worst = 0
  for (let k = 0; k < FRAMES; k++, t += FRAME_MS) {
    const a = performance.now()
    paintScene(scene, t, picture, options, cache)
    const took = performance.now() - a
    total += took
    worst = Math.max(worst, took)
  }

  // A board change: one more files call. The helper builds the scene anew at the moment it paints.
  const changes: number[] = []
  let repainted: string[] = []
  for (let k = 0; k <= MORE_CHANGES; k++) {
    board = { ...board, counts: { ...board.counts, files: (board.counts.files ?? 0) + 1 } }
    const changed = sceneOf(board, t, setup)
    const a = performance.now()
    paintScene(changed, t, picture, options, cache)
    changes.push(performance.now() - a)
    if (k === 0) repainted = cache.repainted.map(key => key.slice(0, key.indexOf('\n')))
    t += FRAME_MS
    for (let j = 0; j < 4; j++, t += FRAME_MS) paintScene(changed, t, picture, options, cache)
  }

  const frame = paintScene(sceneOf(board, t, setup), t, picture, options, cache)
  const s = performance.now()
  for (let k = 0; k < 10; k++) frame.toStraight()
  const straight = (performance.now() - s) / 10

  const avg = total / FRAMES
  const rest = changes.slice(1)
  const verdict = rows === 20 ? ` [budgets ≤ 7 / ≤ 20: ${avg <= 7 ? 'met' : 'OVER'} / ${changes[0]! <= 20 ? 'met' : 'OVER'}]` : ''
  console.log(`${picture.width}×${picture.height} (${rows} rows)${verdict}`)
  console.log(`  no board change: ${ms(avg)} average of ${FRAMES} frames (worst ${ms(worst)})`)
  console.log(`  first frame after counts.files + 1: ${ms(changes[0]!)}, repainting ${repainted.join(', ')}`)
  console.log(`  ${MORE_CHANGES} more changes: average ${ms(rest.reduce((a, b) => a + b, 0) / rest.length)}, worst ${ms(Math.max(...rest))}`)
  console.log(`  toStraight: ${ms(straight)}; layers held: ${cache.size}`)
}

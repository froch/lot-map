import { expect, test } from 'claude-code/testing'
import { GOLDEN_CASES, fingerprint } from './golden-cases'
import { GOLDEN } from './golden-hashes'
import { setupFrom } from './map'
import { sceneOf } from './scene'
import type { SceneNode } from './scene'
import { drawMap } from './svg'

test('the desktop drawing is unchanged, case by case', () => {
  expect(GOLDEN_CASES.length).toBe(68)
  expect(new Set(GOLDEN_CASES.map(g => g.name)).size).toBe(68)
  for (const g of GOLDEN_CASES) expect(`${g.name} ${fingerprint(drawMap(g.board, g.now, setupFrom(g.options)))}`).toBe(`${g.name} ${GOLDEN[g.name]}`)
})

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

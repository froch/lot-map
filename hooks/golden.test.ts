import { expect, test } from 'claude-code/testing'
import { GOLDEN_CASES, fingerprint } from './golden-cases'
import { GOLDEN } from './golden-hashes'
import { drawMap, setupFrom } from './map'

test('the desktop drawing is unchanged, case by case', () => {
  expect(GOLDEN_CASES.length).toBe(68)
  expect(new Set(GOLDEN_CASES.map(g => g.name)).size).toBe(68)
  for (const g of GOLDEN_CASES) expect(`${g.name} ${fingerprint(drawMap(g.board, g.now, setupFrom(g.options)))}`).toBe(`${g.name} ${GOLDEN[g.name]}`)
})

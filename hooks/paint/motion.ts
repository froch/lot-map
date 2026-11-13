import type { Board } from '../../types'
import type { Scene, SceneNode } from '../scene'
import { windowOf } from './timeline'

export type Rate = 0 | 1 | 15 | 20

/** Without a board change for this long, the map repaints at 1 fps at most. */
export const IDLE_CAP_MS = 300_000

/** The latest `startedAt`, `endedAt` or `switchedAt` on the board; 0 when there is none. */
export function changedAt(board: Board): number {
  let latest = board.switchedAt ?? 0
  for (const e of board.entries) latest = Math.max(latest, e.startedAt, e.endedAt ?? 0)
  return latest
}

/** How fast the map moves at `t`, and when it next starts to move if it is still now. */
export function motionAt(scene: Scene, t: number, boardChangedAt: number): { fps: Rate; wakeAt?: number } {
  let fast = false
  let slow = false
  let wakeAt: number | undefined
  const visit = (node: SceneNode, isResting: boolean): void => {
    const resting = isResting || node.isRestingBreath === true
    for (const child of node.children ?? []) {
      if (typeof child === 'string') continue
      if (child.motion !== undefined) {
        if (resting && !scene.isAnyRunning) continue
        const w = windowOf(child, scene.now)
        if (t >= w.from && t < w.to) {
          if (child.motion === 'fast') fast = true
          else slow = true
        } else if (w.from > t && (wakeAt === undefined || w.from < wakeAt)) wakeAt = w.from
      }
      visit(child, resting)
    }
  }
  for (const node of scene.nodes) visit({ tag: '', attrs: [], children: [node] }, false)
  if (fast || slow) {
    const idle = t - boardChangedAt >= IDLE_CAP_MS
    return { fps: idle ? 1 : fast ? 20 : 15 }
  }
  return wakeAt === undefined ? { fps: 0 } : { fps: 0, wakeAt }
}

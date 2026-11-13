// The bodies the plugin posts to the helper. They live here, apart from the hook, so the helper's own specs post
// exactly what the plugin does. No engine calls.
import type { Board } from '../types'
import { changedAt } from './paint/motion'

/** POST /setup: the person's options as the engine hands them, whether to paint the light palette, the ring box's rows. */
export const setupBody = (options: Readonly<Record<string, unknown>>, light: boolean, rows: number): string =>
  JSON.stringify({ options, light, rows })

/** POST /board: the board, the plugin's clock when it posts, and the board's change time. */
export const boardBody = (board: Board, now: number): string => JSON.stringify({ board, now, changedAt: changedAt(board) })

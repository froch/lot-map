// The SVG painter: the scene written out as the SVG desktop, VS Code and mobile show. It only joins the scene's strings.
// Nothing here touches the engine.
import type { Board } from '../types'
import type { Setup } from './map'
import { sceneOf } from './scene'
import type { Scene, SceneNode } from './scene'

/** One node as SVG: an element without children closes itself; text children are already escaped. */
function written(n: SceneNode | string): string {
  if (typeof n === 'string') return n
  const attrs = n.attrs.map(([k, v]) => ` ${k}="${v}"`).join('')
  return n.children === undefined ? `<${n.tag}${attrs}/>` : `<${n.tag}${attrs}>${n.children.map(written).join('')}</${n.tag}>`
}

export function toSvg(scene: Scene): string {
  // Twice the viewBox, so the picture fills whatever room the pane gives it.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${scene.width} ${scene.height}" width="${scene.width * 2}" height="${scene.height * 2}">${scene.style}${scene.nodes.map(written).join('')}</svg>`
}

export function drawMap(board: Board, now: number, setup: Setup): string {
  return toSvg(sceneOf(board, now, setup))
}

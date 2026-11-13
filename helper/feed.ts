// The hand check's stand-in for the terminal: `tail -f out.txt | bun helper/feed.ts`. For each F line on stdin it
// reads the frame from shared memory and unlinks the name, as the terminal does. Once a second while frames come it
// prints how many it read, how many were gone before it got there, and the read time; other lines pass through.
import { loadShm } from './shm'

const shm = loadShm()
let frames = 0
let missing = 0
let readMs = 0
let total = 0
let lastGeneration = 0
let gaps = 0

function take(line: string): void {
  const [, name, w, h, g] = line.split(' ')
  const generation = Number(g)
  if (lastGeneration > 0 && generation !== lastGeneration + 1) gaps++
  lastGeneration = generation
  const a = performance.now()
  const px = shm.read(name!, Number(w) * Number(h) * 4)
  shm.drop(name!)
  readMs += performance.now() - a
  if (px === undefined) missing++
  else frames++
  total++
}

setInterval(() => {
  if (frames + missing === 0) return
  const ms = (readMs / (frames + missing)).toFixed(2)
  console.log(`feed: ${frames} frames/s, ${missing} gone before read, read ${ms} ms, generation ${lastGeneration}, gaps ${gaps}, total ${total}`)
  frames = missing = readMs = 0
}, 1000)

const decoder = new TextDecoder()
let rest = ''
for await (const chunk of Bun.stdin.stream()) {
  rest += decoder.decode(chunk, { stream: true })
  let nl: number
  while ((nl = rest.indexOf('\n')) >= 0) {
    const line = rest.slice(0, nl)
    rest = rest.slice(nl + 1)
    if (line.startsWith('F ')) take(line)
    else if (line !== '') console.log(`helper: ${line}`)
  }
}
process.exit(0)

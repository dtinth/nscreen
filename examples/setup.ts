// npx tsx examples/setup.ts [display-base-url]
// Creates a new screen: saves the publisher credentials to publisher.json and
// prints the display URL. Open that URL on the screen. It holds the screen's
// secret key, so don't keep it anywhere else.
import { existsSync, writeFileSync } from 'node:fs'
import { createScreen } from '../src/publisher.ts'

const FILE = 'publisher.json'
const base = process.argv[2] ?? 'https://nscreen.pages.dev/'
if (existsSync(FILE)) {
  console.error(`${FILE} already exists. Delete it first to make a new screen.`)
  process.exit(1)
}

const { publisher, displayFragment } = createScreen()
writeFileSync(FILE, JSON.stringify(publisher, null, 2), { mode: 0o600 })
const url = new URL(base)
url.hash = displayFragment
console.log('Saved', FILE)
console.log('Open this on the screen:\n ', url.toString())

// npx tsx examples/setup.ts <display-base-url> [screen-name]
// 1. Creates publisher.json (write-only credentials).
// 2. Prints the display URL (no secrets in it). Open it on the screen.
// 3. The screen shows a pairing code. Confirm it here.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline/promises'
import {
  createPublisher,
  displayUrl,
  pair,
  ScreenPublisher,
  toConnectionString,
  type PublisherCredentials,
} from '../src/publisher.ts'

const FILE = 'publisher.json'
const base = process.argv[2] ?? 'https://example.com/'
let creds: PublisherCredentials = existsSync(FILE)
  ? JSON.parse(readFileSync(FILE, 'utf8'))
  : createPublisher({ d: process.argv[3] })
writeFileSync(FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })

console.log('Open this on the screen:\n ', displayUrl(creds, base))
console.log('\nWaiting for the screen to send a pairing request…')

const rl = createInterface({ input: process.stdin, output: process.stdout })
creds = await pair(creds, async ({ code, receiverPubkey }) => {
  const answer = await rl.question(
    `\nScreen ${receiverPubkey.slice(0, 8)}… shows code  ${code}  — does it match? [y/N] `,
  )
  return answer.trim().toLowerCase() === 'y'
})
rl.close()
writeFileSync(FILE, JSON.stringify(creds, null, 2), { mode: 0o600 })
console.log('Paired. Saved', FILE)
console.log('Connection string:\n ', toConnectionString(creds))

const screen = new ScreenPublisher(creds)
await screen.publish({
  html: '<main><h1>Paired ✓</h1><p>Ready for content.</p></main>',
  css: 'body{margin:0;height:100vh;display:grid;place-items:center;text-align:center;font:5vw system-ui;background:#111;color:#eee}',
})
screen.close()

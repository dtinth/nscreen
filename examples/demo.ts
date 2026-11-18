// npx tsx examples/demo.ts   (run examples/setup.ts first)
// Pushes a clock to the screen. The heading uses a view transition:
// change the text and run again to see it animate.
import { readFileSync } from 'node:fs'
import { ScreenPublisher } from '../src/publisher.ts'

const screen = new ScreenPublisher(JSON.parse(readFileSync('publisher.json', 'utf8')))
const result = await screen.publish({
  html: `<main><h1>Hello from ${process.env.USER ?? 'nscreen'}</h1><p id="clock"></p></main>`,
  css: `body { margin:0; height:100vh; display:grid; place-items:center;
               font:6vw/1.2 system-ui; background:#111; color:#eee }
        h1 { view-transition-name: title }`,
  // Runs once per fresh frame. Changing it rebuilds the frame.
  script: `setInterval(() => clock.textContent = new Date().toLocaleTimeString(), 1000)`,
})
console.log(result.relays)
screen.close()

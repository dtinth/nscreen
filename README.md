# nscreen

Push HTML/CSS/JS to a remote screen through Nostr relays. End-to-end encrypted, no backend: one static `index.html` plus a small publisher library.

- **Display:** use the hosted one at <https://nscreen.pages.dev/>, or deploy your own copy of `dist/index.html` anywhere static (it's also in the npm package as `nscreen/display.html`).
- **Publisher:** `npm install nscreen` (Node 22+ or a browser).

## Quick start (landing page)

Open the deployed page **without** a `#fragment`. It generates new keys in your browser and shows two things. If the default relays don't suit you (or block you), tick **Use custom relays** and enter a comma-separated list. Both strings then carry that list. Unticked, both strings leave the relays out and both sides use the built-in defaults.

1. **Display URL**: open it on the screen. It holds the receiver's secret key, so anyone with it can read the content.
2. **Connection string** (`nscreen:sk=…&to=…&r=…`): give it to the publisher. It can update the screen but can't read it.

```ts
import { ScreenPublisher } from 'nscreen'

const screen = new ScreenPublisher(process.env.NSCREEN!)   // the connection string
await screen.publish({
  html: '<h1>Hello</h1>',
  css: 'h1 { view-transition-name: title }',
})
```

### Size limit

`publish()` measures the update exactly as a relay will receive it (the whole `["EVENT", …]` message, after encryption). If it's over `maxLength` (default 64 KB), it throws a `PayloadTooLargeError` and sends nothing. The error gives the size, the limit, and the raw html/css/script sizes.

```ts
new ScreenPublisher(conn, { maxLength: 120_000 })
```

### Expiring updates on relays

```ts
new ScreenPublisher(conn, { ttlSeconds: 3600 })
```

Each update gets a NIP-40 `expiration` tag, so relays that support it delete the update that many seconds after it's published. It's only about relay storage: screens that already received the update keep showing it (and keep it in their cache). A screen that connects after it expired gets nothing until the next update. The expiration time is visible to relays.

Before sealing, the JSON is compressed with deflate (fflate), but only when that makes it smaller. Typical HTML/CSS shrinks to 15–35%, so 64 KB holds roughly 140 KB of varied markup, and much more if it's repetitive (tables, lists). Encryption and base64 then add about a third.

Compression happens inside the encryption, so relays only see the compressed size. Don't publish attacker-controlled text next to secrets you care about: size changes can leak a little about the content (the CRIME/BREACH class of attacks). For a signage screen this rarely matters.

## Setup from the command line

```sh
npx tsx examples/setup.ts https://nscreen.pages.dev/
```

It saves the publisher credentials to `publisher.json` and prints the display URL. In code, use `createScreen()`.

## Development

```sh
npm install
npm run build        # → dist/index.html (display, one self-contained file) and lib/ (publisher library)
npm run typecheck
```

## Keys

| | Holds | Can |
|---|---|---|
| Publisher | Its Nostr signing key + the receiver's **public** key | Write, not read |
| Display | The receiver's **secret** key + the publisher's **public** key | Read, not write |

Each update is sealed to the receiver: ephemeral secp256k1 ECDH → HKDF-SHA256 → AES-256-GCM. The ephemeral secret is discarded right away, so the publisher can't decrypt old updates. Updates are NIP-78 addressable events (kind `30078`, `d=nscreen`), so relays keep only the latest one. One publisher key drives one screen; for another screen, make another key pair. The display only accepts events signed by the publisher.

## The display

- **Console.** A black terminal screen shows each step: keys, relay connections, decrypting, rendering. It stays until the first content renders. It comes back with "Connection lost — reconnecting…" when **every** relay has been down for more than 3 seconds, and hides again when one is live. Press <kbd>`</kbd> to toggle it. Script errors from your content are logged to it. The log keeps only the lines that fit on screen, so it never grows while a display runs for weeks (e.g. as a screensaver). Add `?debug` to also copy log lines to the browser console.
- **Relays.** Each relay reconnects with backoff (1s, 2s, 4s … 30s). A heartbeat every 30s catches dead sockets.
- **Cache.** The last update is kept in `localStorage` and shown right away on reload.

How updates are applied:

| You change | What the display does |
|---|---|
| `html` / `css` | Idiomorph morphs the frame in place, inside `document.startViewTransition()` where supported. Elements stay stable, and CSS alone can animate the change (`view-transition-name`, `::view-transition-*`). Set `viewTransition: false` to skip it. |
| `script` | Builds a fresh frame and runs the new script once. Old timers and listeners go away with the old frame. |
| `reset` (new value) | Builds a fresh frame anyway. `publisher.reset(content)` sets it for you. |

If a script hangs the page, open `index.html?safe#…` to skip scripts, then publish a fix.

## Caveats

- Relays limit event size (often 64–128 KB). Link images by URL; don't embed them.
- Relays don't promise to keep data, so use 2–3 of them.
- Relays can see who publishes, when, and how big each update is. They can't see the content.
- Both keys exist briefly in the one place that makes them (the landing page's tab, or the setup script). Treat the display URL as a secret.

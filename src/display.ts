// The display shell. It never changes at runtime: it holds the receiver key,
// keeps relay connections open, decrypts, and morphs content into an iframe.
// Until content arrives (and whenever every relay is down) it shows a
// terminal-style console of what it's doing.
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import { Idiomorph } from 'idiomorph'
import {
  KIND,
  decodeFragment,
  newSecretKey,
  openEnvelope,
  pairingCode,
  pairingDTag,
  publicKeyOf,
  type Envelope,
} from './protocol.ts'

// ============================================================ console

const $ = (id: string) => document.getElementById(id)!
const consoleEl = $('console')
const logEl = $('log')
const relaysEl = $('relays')
const pairEl = $('pair')
const headlineEl = $('headline')
const logBox = $('logbox')
const setHeadline = (text: string, tone: '' | 'bad' = '') => {
  headlineEl.textContent = text
  headlineEl.className = tone
}

const time = () => new Date().toTimeString().slice(0, 8)
type Level = 'info' | 'ok' | 'warn' | 'error' | 'dim'

// The log keeps only the lines that fit on screen, so a display left running
// for weeks (e.g. as a screensaver) never grows. Browser-console mirroring is
// opt-in with ?debug, because some hosts keep that buffer forever too.
const DEBUG = new URLSearchParams(location.search).has('debug')
const MAX_LINES = 200 // hard cap, in case layout can't be measured

function trimLog() {
  while (logEl.childElementCount > MAX_LINES) logEl.firstElementChild!.remove()
  // Drop the oldest lines until the newest ones fit the visible area.
  while (logEl.childElementCount > 1 && logBox.scrollHeight > logBox.clientHeight) {
    logEl.firstElementChild!.remove()
  }
}
// Re-trim when the log area changes size (window resize, pairing box, headline).
if (typeof ResizeObserver === 'function') new ResizeObserver(trimLog).observe(logBox)
else addEventListener('resize', trimLog)

function log(msg: string, level: Level = 'info') {
  const line = document.createElement('div')
  line.className = level
  line.textContent = `${time()}  ${msg}`
  logEl.appendChild(line)
  trimLog()
  if (DEBUG) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fn(`[nscreen] ${msg}`)
  }
}

let consoleReason: string | null = 'boot'
function showConsole(reason: string) {
  consoleReason = reason
  consoleEl.classList.remove('hidden')
  trimLog()
}
function hideConsole() {
  consoleReason = null
  consoleEl.classList.add('hidden')
}
// Backtick toggles the console, for debugging with a keyboard attached.
addEventListener('keydown', (e) => {
  if (e.key !== '`') return
  if (consoleEl.classList.contains('hidden')) showConsole('manual')
  else if (rendered) hideConsole()
})

const short = (hex: string) => `${hex.slice(0, 8)}…${hex.slice(-4)}`

// ============================================================ setup

const SAFE = new URLSearchParams(location.search).has('safe')

log('nscreen display starting', 'dim')
let addr: ReturnType<typeof decodeFragment>
try {
  addr = decodeFragment(location.hash)
} catch (e) {
  setHeadline('Invalid display URL', 'bad')
  log((e as Error).message, 'error')
  log('expected: index.html#p=<publisher pubkey>&d=<screen name>[&k=<receiver key>][&r=<relay>...]', 'dim')
  throw e
}
log(`screen "${addr.d}", publisher ${short(addr.pubkey)}`)
if (SAFE) log('safe mode: scripts will not run', 'warn')

const store = {
  get(k: string) {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v)
      return true
    } catch {
      return false
    }
  },
}

// Receiver key: from the URL, or (pairing mode) made here and kept here.
const PAIRING = !addr.key
let receiverSk: Uint8Array
if (addr.key) {
  receiverSk = addr.key
  log('receiver key: from URL')
} else {
  const KEY_ID = `nscreen:rx:${addr.pubkey}:${addr.d}`
  const saved = store.get(KEY_ID)
  if (saved && /^[0-9a-f]{64}$/.test(saved)) {
    receiverSk = hexToBytes(saved)
    log('receiver key: loaded from this device')
  } else {
    receiverSk = newSecretKey()
    if (store.set(KEY_ID, bytesToHex(receiverSk))) log('receiver key: created and saved on this device')
    else log('receiver key: created, but localStorage is unavailable — pairing is lost on reload', 'warn')
  }
}
const receiverPub = bytesToHex(publicKeyOf(receiverSk))
log(`receiver pubkey ${short(receiverPub)}`, 'dim')

let paired = false // becomes true once any update decrypts
if (PAIRING) {
  void pairingCode(addr.pubkey, addr.d, receiverPub).then((code) => {
    if (paired) return
    $('pair-code').textContent = code
    pairEl.hidden = false
    setHeadline('Waiting for pairing')
    log(`pairing code ${code} — confirm it on the publisher`, 'ok')
  })
}

// ============================================================ rendering

const CACHE_KEY = `nscreen:last:${addr.pubkey}:${addr.d}`
const FRAME_DOC =
  '<!doctype html><html><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<style id="__nscreen_css"></style></head><body></body></html>'

let latest = { createdAt: 0, seq: 0 }
let rendered = false
let frame: HTMLIFrameElement | null = null
let frameIdentity: string | null = null
let queue: Promise<void> = Promise.resolve()

/** The script and the reset value decide whether a fresh frame is needed. */
const identityOf = (env: Envelope) =>
  JSON.stringify([SAFE ? null : (env.script ?? null), env.reset ?? null])

function buildFrame(): Promise<void> {
  frame?.remove()
  const f = document.createElement('iframe')
  f.title = 'screen'
  frame = f
  const ready = new Promise<void>((resolve) =>
    f.addEventListener(
      'load',
      () => {
        // Surface script errors from the content in the console.
        const w = f.contentWindow!
        w.addEventListener('error', (e) => log(`script error: ${e.message} (line ${e.lineno})`, 'error'))
        w.addEventListener('unhandledrejection', (e) => log(`script rejection: ${String(e.reason)}`, 'error'))
        resolve()
      },
      { once: true },
    ),
  )
  f.srcdoc = FRAME_DOC
  document.body.insertBefore(f, consoleEl)
  return ready
}

function morph(env: Envelope, animate: boolean) {
  const doc = frame!.contentDocument!
  const update = () => {
    doc.getElementById('__nscreen_css')!.textContent = env.css ?? ''
    Idiomorph.morph(doc.body, env.html, { morphStyle: 'innerHTML' })
  }
  // Same-document view transition: style it with CSS only
  // (view-transition-name, ::view-transition-*). No extra JS needed.
  const vt = (doc as Document & { startViewTransition?: (cb: () => void) => unknown }).startViewTransition
  if (animate && env.viewTransition !== false && vt) vt.call(doc, update)
  else update()
}

async function apply(env: Envelope) {
  const id = identityOf(env)
  if (!frame || id !== frameIdentity) {
    log(frame ? 'script/reset changed: building a fresh frame' : 'building frame')
    frameIdentity = id
    await buildFrame()
    morph(env, false)
    if (!SAFE && env.script) {
      const doc = frame!.contentDocument!
      const s = doc.createElement('script')
      s.textContent = env.script
      doc.head.appendChild(s)
      log('script started')
    }
  } else {
    morph(env, true)
  }
  log(`rendered update #${env.seq}`, 'ok')
  if (!rendered) {
    rendered = true
    pairEl.hidden = true
  }
  if (consoleReason === 'boot') hideConsole()
}

async function handle(ev: Event, source: string) {
  if (ev.pubkey !== addr.pubkey || ev.kind !== KIND) return
  if (!ev.tags.some((t) => t[0] === 'd' && t[1] === addr.d)) return
  if (ev.created_at < latest.createdAt) return

  let env: Envelope
  try {
    env = await openEnvelope(ev.content, receiverSk)
  } catch {
    if (ev.created_at >= latest.createdAt && !paired) {
      log(`update ${ev.id.slice(0, 8)} from ${source} is not sealed to this receiver`, 'warn')
      if (PAIRING) log('waiting for the publisher to pair with this screen', 'dim')
    }
    return
  }
  if (env.seq <= latest.seq) return
  latest = { createdAt: ev.created_at, seq: env.seq }
  if (!paired) {
    paired = true
    if (PAIRING) log('paired with publisher', 'ok')
    pairEl.hidden = true
    setHeadline('Loading content…')
  }
  log(`update #${env.seq} from ${source} (${(ev.content.length / 1024).toFixed(1)} KB)`)
  if (source !== 'cache') store.set(CACHE_KEY, JSON.stringify(ev))
  queue = queue.then(() => apply(env)).catch((e) => log(`render failed: ${e}`, 'error'))
}

// Show the last known content immediately, before any relay answers.
const cached = store.get(CACHE_KEY)
if (cached) {
  try {
    const ev = JSON.parse(cached) as Event
    if (verifyEvent(ev)) {
      log('found cached update on this device')
      void handle(ev, 'cache')
    }
  } catch {}
}

// ============================================================ relays

type RelayState = 'connecting' | 'live' | 'down'
const SUB = 'screen'
const HEARTBEAT_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000

class RelayConn {
  state: RelayState = 'connecting'
  private ws: WebSocket | null = null
  private retry = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private hbTimer: ReturnType<typeof setInterval> | undefined
  private hbDeadline: ReturnType<typeof setTimeout> | undefined
  private host: string

  constructor(readonly url: string) {
    this.host = url.replace(/^wss?:\/\//, '')
  }

  connect() {
    clearTimeout(this.reconnectTimer)
    this.setState('connecting')
    log(`${this.host}: connecting`, 'dim')
    let ws: WebSocket
    try {
      ws = new WebSocket(this.url)
    } catch (e) {
      log(`${this.host}: ${e}`, 'error')
      return this.lost()
    }
    this.ws = ws
    ws.onopen = () => {
      if (this.ws !== ws) return
      this.retry = 0
      log(`${this.host}: connected, subscribing`)
      this.send(['REQ', SUB, { kinds: [KIND], authors: [addr.pubkey], '#d': [addr.d], limit: 1 }])
      if (PAIRING && !paired) void this.announce()
      this.hbTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS)
    }
    ws.onmessage = (m) => {
      if (this.ws !== ws) return
      let msg: unknown[]
      try {
        msg = JSON.parse(m.data)
      } catch {
        return
      }
      const [type, a, b] = msg as [string, unknown, unknown]
      if (type === 'EVENT' && a === SUB) {
        const ev = b as Event
        if (verifyEvent(ev)) void handle(ev, this.host)
        else log(`${this.host}: dropped event with bad signature`, 'warn')
      } else if (type === 'EOSE' && a === SUB) {
        log(`${this.host}: live`, 'ok')
        this.setState('live')
      } else if (type === 'EOSE' && a === 'hb') {
        clearTimeout(this.hbDeadline)
        this.send(['CLOSE', 'hb'])
      } else if (type === 'CLOSED') {
        log(`${this.host}: subscription closed: ${b}`, 'warn')
      } else if (type === 'NOTICE') {
        log(`${this.host}: notice: ${a}`, 'dim')
      } else if (type === 'OK' && b === false) {
        log(`${this.host}: rejected our event: ${(msg as unknown[])[3]}`, 'warn')
      }
    }
    ws.onerror = () => {
      if (this.ws === ws) log(`${this.host}: connection error`, 'warn')
    }
    ws.onclose = (e) => {
      if (this.ws !== ws) return
      log(`${this.host}: disconnected${e.code ? ` (${e.code})` : ''}`, 'warn')
      this.lost()
    }
  }

  /** A dead socket can look open for minutes; a cheap REQ proves it's alive. */
  private heartbeat() {
    this.send(['REQ', 'hb', { kinds: [KIND], authors: [addr.pubkey], '#d': [addr.d], limit: 0 }])
    clearTimeout(this.hbDeadline)
    this.hbDeadline = setTimeout(() => {
      log(`${this.host}: no heartbeat reply, reconnecting`, 'warn')
      this.lost()
    }, HEARTBEAT_TIMEOUT_MS)
  }

  /** Pairing mode: tell the publisher which key to seal updates to. */
  async announce() {
    const ev = finalizeEvent(
      {
        kind: KIND,
        created_at: Math.floor(Date.now() / 1000),
        tags: [
          ['d', pairingDTag(addr.d)],
          ['p', addr.pubkey],
        ],
        content: '',
      },
      receiverSk,
    )
    this.send(['EVENT', ev])
    log(`${this.host}: sent pairing request`, 'dim')
  }

  /** Close everything and reconnect with backoff (1s, 2s, 4s … 30s). */
  lost() {
    const ws = this.ws
    this.ws = null
    clearInterval(this.hbTimer)
    clearTimeout(this.hbDeadline)
    try {
      ws?.close()
    } catch {}
    this.setState('down')
    const delay = Math.min(30_000, 1000 * 2 ** this.retry++)
    log(`${this.host}: retrying in ${Math.round(delay / 1000)}s`, 'dim')
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  /** Skip the backoff (e.g. when the network comes back). */
  reconnectNow() {
    if (this.state === 'live') return
    this.retry = 0
    this.connect()
  }

  send(msg: unknown[]) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
  }

  private setState(s: RelayState) {
    if (this.state === s) return
    this.state = s
    onConnectivityChange()
  }
}

log(`relays: ${addr.relays.length}`, 'dim')
const conns = addr.relays.map((u) => new RelayConn(u))

// ============================================================ connectivity → console

const LOST_GRACE_MS = 3000 // ignore blips shorter than this
let lostTimer: ReturnType<typeof setTimeout> | undefined

function renderRelays() {
  relaysEl.replaceChildren(
    ...conns.map((c) => {
      const el = document.createElement('span')
      el.className = `relay ${c.state}`
      el.textContent = c.url.replace(/^wss?:\/\//, '')
      return el
    }),
  )
}

function onConnectivityChange() {
  renderRelays()
  const live = conns.filter((c) => c.state === 'live').length
  if (live > 0) {
    clearTimeout(lostTimer)
    lostTimer = undefined
    if (!rendered && !PAIRING) setHeadline('Connected — waiting for content…')
    if (consoleReason === 'offline') {
      setHeadline('Reconnected')
      log(`back online (${live}/${conns.length} relays live)`, 'ok')
      hideConsole()
    }
  } else if (rendered && !lostTimer && consoleReason !== 'offline') {
    lostTimer = setTimeout(() => {
      lostTimer = undefined
      if (conns.some((c) => c.state === 'live')) return
      log('all relays down — showing console until reconnected', 'error')
      setHeadline('Connection lost — reconnecting…', 'bad')
      showConsole('offline')
    }, LOST_GRACE_MS)
  }
}

addEventListener('offline', () => log('browser reports offline', 'warn'))
addEventListener('online', () => {
  log('browser reports online, reconnecting now')
  conns.forEach((c) => c.reconnectNow())
})

// Pairing mode: re-announce every minute until the first update decrypts.
if (PAIRING) {
  const t = setInterval(() => {
    if (paired) return clearInterval(t)
    conns.forEach((c) => c.state === 'live' && void c.announce())
  }, 60_000)
}

setHeadline(PAIRING && !paired ? 'Waiting for pairing' : 'Connecting…')
renderRelays()
conns.forEach((c) => c.connect())
log(rendered ? 'showing cached content while connecting' : 'waiting for content…', 'dim')

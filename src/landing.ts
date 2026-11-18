// Landing page (no #fragment): makes a new screen in the browser.
// Keys are generated locally with WebCrypto randomness; nothing is sent anywhere.
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex } from 'nostr-tools/utils'
import {
  DEFAULT_RELAYS,
  encodeFragment,
  newSecretKey,
  publicKeyOf,
  toB64u,
  toConnectionString,
} from './protocol.ts'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const nameIn = $<HTMLInputElement>('l-name')
const customIn = $<HTMLInputElement>('l-custom')
const relaysIn = $<HTMLInputElement>('l-relays')
const relayNote = $('l-relay-note')
const urlOut = $<HTMLInputElement>('l-url')
const connOut = $<HTMLInputElement>('l-conn')
const host = (u: string) => u.replace(/^wss?:\/\//, '').replace(/\/$/, '')

/**
 * Custom relays, or [] for the defaults. An empty list leaves the relays out
 * of both strings, so both sides fall back to DEFAULT_RELAYS.
 */
function chosenRelays(): string[] {
  relaysIn.hidden = !customIn.checked
  relaysIn.classList.remove('bad')
  relayNote.classList.remove('bad')
  if (!customIn.checked) {
    relayNote.textContent = `Default relays: ${DEFAULT_RELAYS.map(host).join(', ')}`
    return []
  }
  const parts = relaysIn.value.split(',').map((r) => r.trim()).filter(Boolean)
  const bad = parts.filter((r) => !/^wss?:\/\/[^\s/]+/.test(r))
  const good = parts.filter((r) => !bad.includes(r))
  if (bad.length) {
    relaysIn.classList.add('bad')
    relayNote.classList.add('bad')
    relayNote.textContent = `Ignored (must start with wss://): ${bad.join(', ')}`
  } else if (!good.length) {
    relayNote.classList.add('bad')
    relayNote.textContent = 'Enter at least one relay, comma-separated. Using defaults until then.'
  } else {
    relayNote.textContent = `${good.length} custom relay${good.length > 1 ? 's' : ''}. Both strings below include them.`
  }
  return good
}
const openLink = $<HTMLAnchorElement>('l-open')

let signingKey: Uint8Array
let receiverKey: Uint8Array

function newKeys() {
  signingKey = generateSecretKey()
  receiverKey = newSecretKey()
  nameIn.value = `screen-${toB64u(crypto.getRandomValues(new Uint8Array(4)))}`
  update()
}

function update() {
  const d = nameIn.value.trim() || 'screen'
  const relays = chosenRelays()
  const base = location.origin + location.pathname + location.search
  const url = `${base}#${encodeFragment({ pubkey: getPublicKey(signingKey), d, key: receiverKey, relays })}`
  urlOut.value = url
  openLink.href = url
  connOut.value = toConnectionString({
    secretKey: bytesToHex(signingKey),
    recipient: bytesToHex(publicKeyOf(receiverKey)),
    d,
    relays,
  })
}

nameIn.addEventListener('input', update)
relaysIn.addEventListener('input', update)
customIn.addEventListener('change', () => {
  update()
  if (customIn.checked) relaysIn.focus()
})
$('l-new').addEventListener('click', newKeys)

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const field = $<HTMLInputElement>(btn.dataset.copy!)
    try {
      await navigator.clipboard.writeText(field.value)
    } catch {
      field.select()
      document.execCommand('copy')
    }
    const label = btn.textContent
    btn.textContent = 'Copied'
    setTimeout(() => (btn.textContent = label), 1200)
  })
}

newKeys()

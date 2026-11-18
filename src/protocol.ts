// Shared between the display shell and the publisher library.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { deflateSync, inflateSync } from 'fflate'

/** Nostr kind for the event. NIP-78: addressable, application-specific data. */
export const KIND = 30078

/** `d` tag of every update. One publisher key drives exactly one screen. */
export const D_TAG = 'nscreen'

export const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

/** What you send to the screen. */
export interface ScreenContent {
  /** HTML for the <body>. Morphed in place on each update. */
  html: string
  /** CSS for the page. Replaced on each update. */
  css?: string
  /**
   * JavaScript to run in the page. It runs once, in a fresh frame.
   * If the script changes, the frame is rebuilt, so scripts never pile up.
   */
  script?: string
  /**
   * Change this value (any string or number) to force a fresh frame,
   * even if the script did not change.
   */
  reset?: string | number
  /**
   * Wrap the morph in document.startViewTransition() where supported, so CSS
   * (view-transition-name, ::view-transition-*) can animate updates. Default true.
   */
  viewTransition?: boolean
}

/** What actually gets encrypted. */
export interface Envelope extends ScreenContent {
  v: 1
  /** Monotonic sequence number; the display ignores anything not newer. */
  seq: number
}

// ---------- base64url ----------

export function toB64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64u(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

// ---------- sealed box: ephemeral secp256k1 ECDH + HKDF-SHA256 + AES-256-GCM ----------
// Event content = base64url(ephemeralPub[32] || iv[12] || ciphertext+tag)
//
// The publisher only knows the receiver's PUBLIC key. Each update uses a fresh
// ephemeral keypair whose secret is thrown away right after encrypting, so the
// publisher can never decrypt an update again. Only the receiver can.
// Public keys are 32-byte x-only (same format as Nostr pubkeys).

const INFO = new TextEncoder().encode('nscreen/v2 sealed')

async function deriveKey(sk: Uint8Array, otherXOnly: Uint8Array, salt: Uint8Array, usage: KeyUsage) {
  // ECDH x-coordinate is the same for either y parity, so prefixing 02 is safe.
  const point = new Uint8Array(33)
  point[0] = 2
  point.set(otherXOnly, 1)
  const shared = secp256k1.getSharedSecret(sk, point).slice(1, 33)
  const ikm = await crypto.subtle.importKey('raw', shared as BufferSource, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

/** x-only public key for a secp256k1 secret key. */
export function publicKeyOf(sk: Uint8Array): Uint8Array {
  return secp256k1.getPublicKey(sk, true).slice(1)
}

export function newSecretKey(): Uint8Array {
  return secp256k1.utils.randomSecretKey()
}

// ---------- compression (inside the encryption) ----------
// Plaintext is either raw JSON (starts with "{", 0x7b) or 0x01 + deflate-raw(JSON).
const FORMAT_DEFLATE = 0x01

/** JSON-encode an envelope, deflating it when that's smaller. */
export function packEnvelope(env: Envelope): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(env))
  const deflated = deflateSync(json, { level: 9, mem: 8 })
  if (deflated.length + 1 >= json.length) return json
  const out = new Uint8Array(deflated.length + 1)
  out[0] = FORMAT_DEFLATE
  out.set(deflated, 1)
  return out
}

function unpackEnvelope(plain: Uint8Array): Envelope {
  const json = plain[0] === FORMAT_DEFLATE ? inflateSync(plain.subarray(1)) : plain
  const env = JSON.parse(new TextDecoder().decode(json))
  if (env?.v !== 1 || typeof env.seq !== 'number' || typeof env.html !== 'string') {
    throw new Error('Unrecognized envelope')
  }
  return env
}

export async function sealEnvelope(env: Envelope, recipientPub: Uint8Array): Promise<string> {
  const eph = newSecretKey()
  const ephPub = publicKeyOf(eph)
  // salt binds the derived key to both public keys
  const key = await deriveKey(eph, recipientPub, concat(ephPub, recipientPub), 'encrypt')
  eph.fill(0)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const plain = packEnvelope(env)
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain as BufferSource))
  return toB64u(concat(ephPub, iv, ct))
}

export async function openEnvelope(content: string, recipientSk: Uint8Array): Promise<Envelope> {
  const data = fromB64u(content)
  const ephPub = data.slice(0, 32)
  const key = await deriveKey(recipientSk, ephPub, concat(ephPub, publicKeyOf(recipientSk)), 'decrypt')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(32, 44) }, key, data.slice(44))
  return unpackEnvelope(new Uint8Array(plain))
}

function concat(...parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) (out.set(p, i), (i += p.length))
  return out
}

// ---------- display URL fragment ----------
// #p=<publisher pubkey hex>&k=<receiver secret key b64url>&r=<relay>...

export interface ScreenAddress {
  pubkey: string
  /** Receiver's secret key. */
  key: Uint8Array
  relays: string[]
}

export function encodeFragment(a: ScreenAddress): string {
  const q = new URLSearchParams()
  q.set('p', a.pubkey)
  q.set('k', toB64u(a.key))
  for (const r of a.relays) q.append('r', r)
  return q.toString()
}

export function decodeFragment(hash: string): ScreenAddress {
  const q = new URLSearchParams(hash.replace(/^#/, ''))
  const pubkey = q.get('p') ?? ''
  const k = q.get('k') ?? ''
  if (!/^[0-9a-f]{64}$/.test(pubkey) || !k) {
    throw new Error('URL fragment must contain p (publisher pubkey) and k (receiver key)')
  }
  const relays = q.getAll('r')
  const key = fromB64u(k)
  if (key.length !== 32) throw new Error('k must be a 32-byte receiver key')
  return { pubkey, key, relays: relays.length ? relays : DEFAULT_RELAYS }
}

// ---------- connection string (publisher side) ----------
// nscreen:sk=<signing key hex>&to=<receiver pubkey hex>&r=<relay>...

/**
 * Everything needed to publish to one screen. It can WRITE to the screen but
 * can't READ anything: it holds only the receiver's public key.
 */
export interface PublisherCredentials {
  /** Nostr secret key (hex). Signs updates. */
  secretKey: string
  /** Receiver's public key (hex, x-only). */
  recipient: string
  relays: string[]
}

export function toConnectionString(c: PublisherCredentials): string {
  const q = new URLSearchParams()
  q.set('sk', c.secretKey)
  q.set('to', c.recipient)
  for (const r of c.relays) q.append('r', r)
  return `nscreen:${q}`
}

export function parseConnectionString(s: string): PublisherCredentials {
  if (!s.startsWith('nscreen:')) throw new Error('Connection string must start with "nscreen:"')
  const q = new URLSearchParams(s.slice('nscreen:'.length).trim())
  const secretKey = q.get('sk') ?? ''
  const recipient = q.get('to') ?? ''
  if (!/^[0-9a-f]{64}$/.test(secretKey) || !/^[0-9a-f]{64}$/.test(recipient)) {
    throw new Error('Connection string needs sk and to')
  }
  const relays = q.getAll('r')
  return { secretKey, recipient, relays: relays.length ? relays : DEFAULT_RELAYS }
}

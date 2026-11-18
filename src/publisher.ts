import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { publishToRelay, subscribeRelays, type RelayResult } from './relay-client.ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import {
  DEFAULT_RELAYS,
  KIND,
  encodeFragment,
  newSecretKey,
  pairingCode,
  pairingDTag,
  publicKeyOf,
  sealEnvelope,
  toB64u,
  packEnvelope,
  parseConnectionString,
  type PublisherCredentials,
  type ScreenContent,
} from './protocol.ts'

export type { ScreenContent, PublisherCredentials } from './protocol.ts'
export { toConnectionString, parseConnectionString } from './protocol.ts'

const newName = () => `screen-${toB64u(crypto.getRandomValues(new Uint8Array(6)))}`

/**
 * Pairing flow (recommended): make a publisher, open displayUrl() on the
 * screen, then call pair(). The receiver secret is created on the screen and
 * never leaves it.
 */
export function createPublisher(opts: { d?: string; relays?: string[] } = {}): PublisherCredentials {
  return {
    secretKey: bytesToHex(generateSecretKey()),
    d: opts.d ?? newName(),
    relays: opts.relays ?? DEFAULT_RELAYS,
  }
}

/** The URL to open on the screen. It holds no secrets (pairing mode). */
export function displayUrl(creds: PublisherCredentials, baseUrl: string): string {
  const url = new URL(baseUrl)
  url.hash = encodeFragment({ pubkey: publisherPubkey(creds), d: creds.d, relays: creds.relays })
  return url.toString()
}

export function publisherPubkey(creds: PublisherCredentials): string {
  return getPublicKey(hexToBytes(creds.secretKey))
}

export interface PairingRequest {
  receiverPubkey: string
  /** Same 8-digit code the screen shows. A human must compare them. */
  code: string
}

/**
 * Wait for a screen in pairing mode to announce itself. Each request is passed
 * to `confirm`; return true only if its code matches the one on the screen.
 * Resolves with the credentials, now including `recipient`.
 */
export async function pair(
  creds: PublisherCredentials,
  confirm: (req: PairingRequest) => boolean | Promise<boolean>,
  opts: { signal?: AbortSignal } = {},
): Promise<PublisherCredentials> {
  const pub = publisherPubkey(creds)
  const seen = new Set<string>()
  let chain = Promise.resolve()
  let close = () => {}
  try {
    return await new Promise<PublisherCredentials>((resolve, reject) => {
      opts.signal?.addEventListener('abort', () => reject(opts.signal!.reason), { once: true })
      close = subscribeRelays(
        creds.relays,
        {
          kinds: [KIND],
          '#d': [pairingDTag(creds.d)],
          '#p': [pub],
          since: Math.floor(Date.now() / 1000) - 600,
        },
        (ev) => {
          if (seen.has(ev.pubkey)) return
          seen.add(ev.pubkey)
          chain = chain.then(async () => {
            const req = { receiverPubkey: ev.pubkey, code: await pairingCode(pub, creds.d, ev.pubkey) }
            if (await confirm(req)) resolve({ ...creds, recipient: ev.pubkey })
          })
        },
      )
    })
  } finally {
    close()
  }
}

export interface NewScreen {
  publisher: PublisherCredentials
  /**
   * URL fragment for the display (starts with "#"), including the receiver's
   * secret key. Append it to wherever you deployed index.html, open it on the
   * screen, and don't store it on the publisher side.
   */
  displayFragment: string
}

/**
 * No-pairing flow: create both keys in one place and put the receiver secret
 * in the display URL. Handy for automated setups.
 */
export function createScreen(opts: { d?: string; relays?: string[] } = {}): NewScreen {
  const publisher = createPublisher(opts)
  const receiverKey = newSecretKey()
  const displayFragment =
    '#' + encodeFragment({ pubkey: publisherPubkey(publisher), d: publisher.d, key: receiverKey, relays: publisher.relays })
  publisher.recipient = bytesToHex(publicKeyOf(receiverKey))
  receiverKey.fill(0)
  return { publisher, displayFragment }
}

export interface PublishResult {
  id: string
  seq: number
  /** Per-relay outcome. At least one `ok` means the screen will get it. */
  relays: RelayResult[]
}

/**
 * Default limit for one update, in bytes, measured as the relay sees it: the
 * whole ["EVENT", …] message, after compression, encryption and base64.
 * Many relays reject messages over 64–128 KB.
 */
export const DEFAULT_MAX_LENGTH = 64 * 1024

export interface PublisherOptions {
  /** Reject updates bigger than this many bytes. Default 64 KB. */
  maxLength?: number
}

/** Thrown by publish() when an update is over `maxLength`. Nothing is sent. */
export class PayloadTooLargeError extends Error {
  constructor(
    /** Size of the ["EVENT", …] message in bytes. */
    readonly size: number,
    readonly maxLength: number,
    /** UTF-8 sizes of the raw fields, and of all of them after compression. */
    readonly fields: { html: number; css: number; script: number; compressed: number },
  ) {
    super(
      `Update is ${size} bytes, over the ${maxLength}-byte limit ` +
        `(html ${fields.html}, css ${fields.css}, script ${fields.script} bytes raw; ` +
        `${fields.compressed} bytes compressed, before encryption)`,
    )
    this.name = 'PayloadTooLargeError'
  }
}

const utf8Length = (s = '') => new TextEncoder().encode(s).length

export class ScreenPublisher {
  private sk: Uint8Array
  private recipient: Uint8Array | null
  private lastSeq = 0
  private lastCreatedAt = 0

  private creds: PublisherCredentials
  readonly maxLength: number

  /** Takes a connection string ("nscreen:…") or a credentials object. */
  constructor(creds: string | PublisherCredentials, opts: PublisherOptions = {}) {
    this.maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH
    this.creds = typeof creds === 'string' ? parseConnectionString(creds) : creds
    creds = this.creds
    this.sk = hexToBytes(creds.secretKey)
    this.recipient = creds.recipient ? hexToBytes(creds.recipient) : null
  }

  /**
   * Seal, sign and send new content to the screen.
   * Throws PayloadTooLargeError (and sends nothing) if it's over maxLength.
   */
  async publish(content: ScreenContent): Promise<PublishResult> {
    if (!this.recipient) throw new Error('No recipient yet: pair() with a screen first')
    // Date.now() keeps seq increasing across processes; the max() keeps it
    // increasing within one process even if two calls land in the same ms.
    const seq = Math.max(Date.now(), this.lastSeq + 1)
    this.lastSeq = seq
    // Relays keep the event with the highest created_at (seconds), so make
    // sure rapid updates don't tie.
    const createdAt = Math.max(Math.floor(Date.now() / 1000), this.lastCreatedAt + 1)
    this.lastCreatedAt = createdAt

    const event = finalizeEvent(
      {
        kind: KIND,
        created_at: createdAt,
        tags: [['d', this.creds.d]],
        content: await sealEnvelope({ v: 1, seq, ...content }, this.recipient),
      },
      this.sk,
    )

    const size = utf8Length(JSON.stringify(['EVENT', event]))
    if (size > this.maxLength) {
      throw new PayloadTooLargeError(size, this.maxLength, {
        html: utf8Length(content.html),
        css: utf8Length(content.css),
        script: utf8Length(content.script),
        compressed: packEnvelope({ v: 1, seq, ...content }).length,
      })
    }

    const relays = await Promise.all(this.creds.relays.map((url) => publishToRelay(url, event)))
    if (!relays.some((r) => r.ok)) {
      throw Object.assign(new Error('No relay accepted the update'), { relays })
    }
    return { id: event.id, seq, relays }
  }

  /** Force the display to rebuild its frame (e.g. after a script broke the layout). */
  reset(content: ScreenContent): Promise<PublishResult> {
    return this.publish({ ...content, reset: Date.now() })
  }

  /** Kept for compatibility; each publish opens and closes its own connections. */
  close() {}
}

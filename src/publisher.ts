import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { publishToRelay, type RelayResult } from './relay-client.ts'
import { bytesToHex, hexToBytes } from 'nostr-tools/utils'
import {
  DEFAULT_RELAYS,
  KIND,
  D_TAG,
  encodeFragment,
  newSecretKey,
  publicKeyOf,
  sealEnvelope,
  packEnvelope,
  parseConnectionString,
  type PublisherCredentials,
  type ScreenContent,
} from './protocol.ts'

export type { ScreenContent, PublisherCredentials } from './protocol.ts'
export { toConnectionString, parseConnectionString } from './protocol.ts'

export function publisherPubkey(creds: PublisherCredentials): string {
  return getPublicKey(hexToBytes(creds.secretKey))
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
 * Create a new screen: a publisher signing key and a receiver key. The
 * receiver's secret goes only into the display URL; the publisher keeps its
 * public key. Same as the landing page, in code.
 */
export function createScreen(opts: { relays?: string[] } = {}): NewScreen {
  const relays = opts.relays ?? DEFAULT_RELAYS
  const signingKey = generateSecretKey()
  const receiverKey = newSecretKey()
  const publisher: PublisherCredentials = {
    secretKey: bytesToHex(signingKey),
    recipient: bytesToHex(publicKeyOf(receiverKey)),
    relays,
  }
  const displayFragment = '#' + encodeFragment({ pubkey: getPublicKey(signingKey), key: receiverKey, relays })
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
export const DEFAULT_MAX_LENGTH: number = 64 * 1024

export interface PublisherOptions {
  /** Reject updates bigger than this many bytes. Default 64 KB. */
  maxLength?: number
  /**
   * Ask relays to delete each update this many seconds after it's published
   * (NIP-40 `expiration` tag). Screens that already received it keep showing
   * it; a screen that connects later gets nothing until the next update.
   * Default: no expiration.
   */
  ttlSeconds?: number
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
  private recipient: Uint8Array
  private lastSeq = 0
  private lastCreatedAt = 0

  private creds: PublisherCredentials
  readonly maxLength: number
  readonly ttlSeconds: number | undefined

  /** Takes a connection string ("nscreen:…") or a credentials object. */
  constructor(creds: string | PublisherCredentials, opts: PublisherOptions = {}) {
    this.maxLength = opts.maxLength ?? DEFAULT_MAX_LENGTH
    if (opts.ttlSeconds !== undefined && !(opts.ttlSeconds > 0)) {
      throw new RangeError('ttlSeconds must be a positive number')
    }
    this.ttlSeconds = opts.ttlSeconds
    this.creds = typeof creds === 'string' ? parseConnectionString(creds) : creds
    creds = this.creds
    this.sk = hexToBytes(creds.secretKey)
    this.recipient = hexToBytes(creds.recipient)
  }

  /**
   * Seal, sign and send new content to the screen.
   * Throws PayloadTooLargeError (and sends nothing) if it's over maxLength.
   */
  async publish(content: ScreenContent): Promise<PublishResult> {
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
        tags: [
          ['d', D_TAG],
          ...(this.ttlSeconds ? [['expiration', String(createdAt + Math.ceil(this.ttlSeconds))]] : []),
        ],
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
  close(): void {}
}

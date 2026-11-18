// Minimal one-shot relay operations for the publisher side (Node 22+ or browser).
// Each relay is independent: one that is down, slow or refusing never affects the others.
import type { Event } from 'nostr-tools/pure'

export interface RelayResult {
  url: string
  ok: boolean
  message: string
}

/** Send one event to one relay and wait for its OK. Never throws. */
export function publishToRelay(url: string, event: Event, timeoutMs = 8000): Promise<RelayResult> {
  return new Promise((resolve) => {
    let ws: WebSocket
    let done = false
    const finish = (ok: boolean, message: string) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        ws?.close()
      } catch {}
      resolve({ url, ok, message })
    }
    const timer = setTimeout(() => finish(false, `no reply within ${timeoutMs / 1000}s`), timeoutMs)
    try {
      ws = new WebSocket(url)
    } catch (e) {
      return finish(false, String((e as Error).message ?? e))
    }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]))
    ws.onmessage = (m) => {
      try {
        const [type, id, ok, msg] = JSON.parse(String(m.data))
        if (type === 'OK' && id === event.id) finish(ok === true, String(msg ?? ''))
      } catch {}
    }
    ws.onerror = () => finish(false, 'connection failed')
    ws.onclose = () => finish(false, 'connection closed before OK')
  })
}

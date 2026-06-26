/**
 * Onyx Base — realtime notifier.
 *
 * Mutations (set / delete) fire an internal HTTP ping to the WebSocket
 * mini-service on port 3003. The WS service then pushes a `record:changed`
 * event to every dashboard tab subscribed to that developer's userId.
 *
 * This is fire-and-forget: if the WS service is down, writes still succeed.
 */

const WS_PORT = 3003
const WS_URL = `http://localhost:${WS_PORT}/notify`

export interface RealtimeEvent {
  userId: string
  event: 'set' | 'delete'
  collection: string
  key: string
}

export function notifyRealtime(evt: RealtimeEvent) {
  fetch(WS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(evt),
  }).catch(() => {
    /* WS service unavailable — non-fatal */
  })
}

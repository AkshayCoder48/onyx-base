/**
 * GET /api/v5/realtime — SSE event stream (docs/v5-contract.md §18).
 *
 * Best-effort push: heartbeats every 15s, closes at 50s (serverless-safe);
 * clients MUST reconnect automatically (EventSource does) and fall back to
 * GET /api/v5/events polling.
 */
import { NextRequest } from 'next/server'
import { v5AuthBearer } from '@/lib/v5/auth'
import { subscribe, queryEvents, type V5Event } from '@/lib/v5/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

const HEARTBEAT_MS = 15_000
const MAX_STREAM_MS = 50_000

function sseChunk(evt: V5Event): string {
  return `event: v5\ndata: ${JSON.stringify({ id: evt.id, type: evt.type, subject: evt.subject, payload: evt.payload, createdAt: evt.createdAt })}\n\n`
}

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = req.headers.get('x-request-id') || crypto.randomUUID()
  const user = await v5AuthBearer(req.headers.get('authorization'))
  if (!user) {
    return new Response(JSON.stringify({ ok: false, error: 'A valid Bearer API key is required.', code: 'AUTH_REQUIRED', requestId }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-request-id': requestId },
    })
  }
  const since = Number(req.nextUrl.searchParams.get('since')) || 0
  const backlog = await queryEvents(user.owner, { since, limit: 100 })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false
      const send = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          closed = true
        }
      }
      send(`retry: 3000\n\n`)
      for (const evt of backlog.events) send(sseChunk(evt))

      const unsubscribe = subscribe(user.owner, (evt) => send(sseChunk(evt)))
      const heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS)
      const finish = () => {
        if (closed) return
        closed = true
        clearInterval(heartbeat)
        unsubscribe()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
      req.signal.addEventListener('abort', finish)
      setTimeout(finish, MAX_STREAM_MS)
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-request-id': requestId,
    },
  })
}

/**
 * Onyx Base — realtime WebSocket mini-service.
 *
 * - Listens on port 3003 (hardcoded — Caddy gateway forwards ?XTransformPort=3003 here).
 * - socket.io server attached with path: '/' so Caddy's port-transform rule works.
 * - HTTP POST /notify (handled on the same http server) is how the Next.js API
 *   fires fire-and-forget pings whenever a record is set or deleted.
 * - On each /notify ping, the service emits a `record:changed` event to every
 *   dashboard socket that has subscribed to that userId's room.
 */

import { createServer, IncomingMessage, ServerResponse } from 'http'
import { Server, Socket } from 'socket.io'

const PORT = 3003

// ---------------------------------------------------------------------------
// HTTP server + socket.io (socket.io attaches itself to the same server)
// ---------------------------------------------------------------------------

// NOTE on the prepend-listeners dance below:
// With socket.io's `path: '/'` (required by Caddy), socket.io's own request
// listener would intercept EVERY URL — including POST /notify — and reply with
// `{"code":0,"message":"Transport unknown"}`.  To win the race we register
// socket.io first, snapshot its listeners, remove them, then re-add a wrapper
// that handles /notify before delegating the rest to socket.io.  This is the
// canonical "custom server alongside socket.io" pattern.

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path — Caddy uses ?XTransformPort=3003 to forward here.
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
})

// Snapshot socket.io's request listeners, then prepend our own router.
const ioListeners = httpServer.listeners('request').slice(0)
httpServer.removeAllListeners('request')
httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
  // Manual HTTP routing — must run BEFORE socket.io so /notify is reachable.
  if (req.method === 'POST' && req.url !== undefined && req.url.startsWith('/notify')) {
    return handleNotify(req, res)
  }
  // Delegate everything else to socket.io (polling / upgrade traffic).
  for (const listener of ioListeners) {
    listener.call(httpServer, req, res)
  }
})

// ---------------------------------------------------------------------------
// /notify endpoint
// ---------------------------------------------------------------------------

interface NotifyBody {
  userId?: string
  event?: 'set' | 'delete' | string
  collection?: string
  key?: string
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function handleNotify(req: IncomingMessage, res: ServerResponse) {
  let parsed: NotifyBody = {}
  try {
    const raw = await readBody(req)
    if (raw.trim().length > 0) {
      parsed = JSON.parse(raw) as NotifyBody
    }
  } catch (err) {
    // Graceful: bad JSON should not 500 the Next.js fire-and-forget caller.
    console.error('[notify] body parse failed:', (err as Error).message)
    return sendJson(res, 200, { ok: false, error: 'invalid_json' })
  }

  const { userId, event, collection, key } = parsed

  if (!userId || !event || !collection || !key) {
    return sendJson(res, 200, {
      ok: false,
      error: 'missing_fields',
      required: ['userId', 'event', 'collection', 'key'],
    })
  }

  const room = `user:${userId}`
  io.to(room).emit('record:changed', {
    event,
    collection,
    key,
    ts: Date.now(),
  })

  console.log(
    `[notify] userId=${userId} event=${event} collection=${collection} key=${key} -> room ${room}`,
  )

  return sendJson(res, 200, { ok: true })
}

// ---------------------------------------------------------------------------
// socket.io connection lifecycle
// ---------------------------------------------------------------------------

io.on('connection', (socket: Socket) => {
  console.log(`[io] connected: ${socket.id}`)

  // Subscribe a dashboard tab to a developer's userId room.
  socket.on('subscribe', (data: { userId?: string }) => {
    const userId = data?.userId
    if (typeof userId !== 'string' || userId.length === 0) {
      socket.emit('error', { message: 'subscribe requires { userId }' })
      return
    }
    const room = `user:${userId}`
    socket.join(room)
    socket.emit('subscribed', { userId })
    console.log(`[io] ${socket.id} subscribed -> ${room}`)
  })

  // Unsubscribe.
  socket.on('unsubscribe', (data: { userId?: string }) => {
    const userId = data?.userId
    if (typeof userId !== 'string') return
    const room = `user:${userId}`
    socket.leave(room)
    console.log(`[io] ${socket.id} unsubscribed <- ${room}`)
  })

  // Lightweight keepalive the dashboard can use to measure latency.
  socket.on('ping', (data: unknown) => {
    socket.emit('pong', { t: Date.now(), echo: data ?? null })
  })

  socket.on('disconnect', (reason: string) => {
    console.log(`[io] disconnected: ${socket.id} (${reason})`)
  })

  socket.on('error', (err: Error) => {
    console.error(`[io] socket error (${socket.id}):`, err.message)
  })
})

// ---------------------------------------------------------------------------
// Boot + graceful shutdown
// ---------------------------------------------------------------------------

httpServer.listen(PORT, () => {
  console.log(`Onyx Base realtime service running on port ${PORT}`)
})

function shutdown(signal: string) {
  console.log(`[${signal}] shutting down realtime service...`)
  // Stop accepting new connections, close existing sockets cleanly.
  io.close(() => {
    httpServer.close(() => {
      console.log('[shutdown] realtime service closed')
      process.exit(0)
    })
  })
  // Safety net: if graceful close hangs, force-exit after 5s.
  setTimeout(() => {
    console.error('[shutdown] force-exit after timeout')
    process.exit(1)
  }, 5000).unref()
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

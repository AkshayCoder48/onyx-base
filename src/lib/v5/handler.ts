/**
 * OnyxBase V5 — route handler wrapper (docs/v5-contract.md).
 *
 * Response shapes (ALL V5 routes):
 *   200/201 { ok: true,  data, requestId, durationMs }
 *   4xx/5xx { ok: false, error, code, requestId, durationMs }
 * Header: x-request-id on every response.
 *
 * Structured log line per request — NEVER logs keys, tokens, or values.
 */

import { NextRequest } from 'next/server'
import { randomUUID } from 'node:crypto'
import { v5AuthBearer, type V5Account } from './auth'
import { V5Error, V5_CODE_STATUS } from './errors'
import { v5EnsureBootRestore } from './db'
import { maybeBackgroundProbe } from './sync'

export type { V5ErrorCode } from './errors'
export { V5Error }

export interface V5Ctx {
  requestId: string
  user: V5Account | null
  ok: (data: unknown, init?: { status?: number }) => Response
  fail: (code: import('./errors').V5ErrorCode, message: string, status?: number) => never
}

interface HandlerOpts<T = unknown> {
  operation: string
  auth: 'bearer' | 'none'
  maxBytes?: number
  handler: (req: NextRequest, ctx: V5Ctx, routeCtx?: T) => Promise<Response>
}

const STATUS_BY_CODE = V5_CODE_STATUS

function json(body: unknown, status: number, requestId: string, durationMs: number): Response {
  return new Response(JSON.stringify({ ...(body as Record<string, unknown>), requestId, durationMs }), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      'cache-control': 'no-store',
    },
  })
}

export function withV5Handler<T = unknown>(opts: HandlerOpts<T>) {
  return async (req: NextRequest, routeCtx?: T): Promise<Response> => {
    const requestId = req.headers.get('x-request-id') || randomUUID()
    const t0 = Date.now()
    let status = 500
    let user: V5Account | null = null
    try {
      // Cold-boot recovery: file-mode instances with an EMPTY database
      // auto-restore from the latest Telegram snapshot. The first request
      // after a cold start awaits it (once per instance); later requests
      // resolve instantly.
      await v5EnsureBootRestore()
      if (opts.auth === 'bearer') {
        const auth = await v5AuthBearer(req.headers.get('authorization'))
        if (!auth) {
          throw new V5Error('AUTH_REQUIRED', 'A valid Bearer API key is required.', 401)
        }
        user = auth
        // Bounded staleness for HIT paths: every authenticated request arms a
        // rate-limited (10s/instance) durable background probe of the shared
        // snapshot pointer — an instance holding an OLD value for a key would
        // otherwise serve it forever (miss probes only fire on misses).
        maybeBackgroundProbe()
      }
      const ctx: V5Ctx = {
        requestId,
        user,
        ok: (data, init) => {
          status = init?.status ?? 200
          return json({ ok: true, data }, status, requestId, Date.now() - t0)
        },
        fail: (code, message, forced) => {
          throw new V5Error(code, message, forced ?? STATUS_BY_CODE[code])
        },
      }
      const res = await opts.handler(req, ctx, routeCtx)
      status = res.status
      return res
    } catch (err) {
      if (err instanceof V5Error) {
        status = err.status
        return json({ ok: false, error: err.message, code: err.code, ...err.extra }, status, requestId, Date.now() - t0)
      }
      const msg = err instanceof Error ? err.message : String(err)
      const dbDown = /database|v5_database_url|sqlite|libsql|no such table/i.test(msg)
      status = dbDown ? 503 : 500
      const code: import("./errors").V5ErrorCode = dbDown ? 'DATABASE_UNAVAILABLE' : 'UNKNOWN_ERROR'
      console.error(`[v5] ${opts.operation} failed: ${msg}`)
      return json({ ok: false, error: dbDown ? 'The V5 database is unavailable.' : 'Unexpected server error.', code }, status, requestId, Date.now() - t0)
    } finally {
      // One structured line per request. No keys, no values.
      console.log(
        JSON.stringify({
          t: new Date().toISOString(),
          requestId,
          route: `/api/v5/${opts.operation}`,
          method: req.method,
          status,
          durationMs: Date.now() - t0,
          operation: opts.operation,
          owner: user?.owner ?? null,
        })
      )
    }
  }
}

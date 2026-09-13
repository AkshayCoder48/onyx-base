/**
 * Onyx Base — API route handler wrapper.
 *
 * Every API route in the app should be wrapped with `withApiHandler`. The
 * wrapper centralizes:
 *   - Request ID generation / propagation
 *   - Error → response normalization (never lets an exception escape as a 500
 *     with a stack trace; always returns a structured JSON error with a
 *     request ID)
 *   - Standard response shape: `{ ok: true, data } | { ok: false, error, code, requestId }`
 *
 * Usage:
 *   export const POST = withApiHandler({
 *     operation: 'telegram.config.save',
 *     requireAuth: true,        // validates Bearer token, returns 401 on missing
 *     requireAdmin: false,      // also requires onyxbase_* admin key
 *     authorize: { scope: 'write' },  // optional: per-key policy check
 *     handler: async (req, ctx) => {
 *       const body = await req.json()
 *       return ctx.ok({ saved: true })
 *     },
 *   })
 *
 * The `ctx` argument exposes:
 *   - requestId  — the trace ID for this request
 *   - user       — the authenticated user (when requireAuth is true)
 *   - ok(data, init?)  — success response (status 200 by default)
 *   - fail(message, status, extra?) — failure response with requestId baked in
 *   - failWithCode(code, message, status, extra?)
 *   - log(fields, level) — structured logger with requestId + operation
 */

import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, type AuthenticatedUser, type AuthorizeOptions } from '@/lib/auth'
import { resolveRequestId, withRequestId, logRequest } from '@/lib/request-id'

export interface ApiHandlerCtx {
  requestId: string
  user: AuthenticatedUser | null
  /** Structured logger that includes the request ID + operation tag. */
  log: (fields: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void
  /** Build a success response. */
  ok: <T extends object = Record<string, unknown>>(data: T, init?: ResponseInit) => Response
  /** Build a failure response with the request ID baked in. */
  fail: (message: string, status?: number, extra?: Record<string, unknown>) => Response
  /** Build a failure response with an explicit error code. */
  failWithCode: (code: string, message: string, status?: number, extra?: Record<string, unknown>) => Response
}

export interface WithApiHandlerOptions {
  /** Short, dotted operation tag, e.g. `telegram.config.save`. Greppable in logs. */
  operation: string
  /** When true (default), validate the Bearer token and return 401 on missing. */
  requireAuth?: boolean
  /** When true, additionally require an `onyxbase_*` admin key. */
  requireAdmin?: boolean
  /** Optional per-key policy check (scope / collection / table / bytes). */
  authorize?: AuthorizeOptions
  /** The actual route handler. */
  handler: (req: NextRequest, ctx: ApiHandlerCtx) => Promise<Response> | Response
}

/**
 * Wrap a route handler with the standard Onyx Base API contract:
 * authentication, request IDs, structured errors, and consistent response shape.
 */
export function withApiHandler(opts: WithApiHandlerOptions): (req: NextRequest, params?: unknown) => Promise<Response> {
  return async (req: NextRequest, _params?: unknown): Promise<Response> => {
    const requestId = resolveRequestId(req.headers)
    const requireAuth = opts.requireAuth !== false
    const requireAdmin = opts.requireAdmin === true

    const log = (fields: Record<string, unknown>, level: 'info' | 'warn' | 'error' = 'info') =>
      logRequest(requestId, opts.operation, fields, level)

    // Build standard helpers. They MUST embed the requestId so the client can
    // always trace a failure back to a server log line.
    const ok = <T extends object = Record<string, unknown>>(data: T, init: ResponseInit = {}): Response =>
      Response.json({ ok: true, requestId, ...(data as Record<string, unknown>) }, withRequestId(requestId, init))

    const fail = (message: string, status = 400, extra: Record<string, unknown> = {}): Response =>
      Response.json({ ok: false, error: message, requestId, ...extra }, withRequestId(requestId, { status }))

    const failWithCode = (code: string, message: string, status = 400, extra: Record<string, unknown> = {}): Response =>
      Response.json({ ok: false, error: message, code, requestId, ...extra }, withRequestId(requestId, { status }))

    const ctx: ApiHandlerCtx = { requestId, user: null, log, ok, fail, failWithCode }

    // Auth phase.
    if (requireAuth) {
      let user: AuthenticatedUser | null
      try {
        user = await authenticate(req.headers.get('authorization'))
      } catch (err) {
        // This is the bug we're killing: previously, ANY error during
        // authenticate (including a network failure during Telegram
        // rehydrate-on-miss) was swallowed and surfaced to the user as a
        // flat "Unauthorized" 401. Now we distinguish:
        //   - Invalid / missing Bearer token → 401 (correct)
        //   - Network / rehydrate failure → 503 (the user IS authorized, the
        //     server just couldn't reach the durable backend)
        log({ stage: 'auth.exception', error: err instanceof Error ? err.message : String(err) }, 'error')
        return fail(
          'Could not validate your session because the durable backend is temporarily unreachable. Please try again in a moment.',
          503,
          { code: 'auth_backend_unavailable' },
        )
      }
      if (!user) {
        // The token is genuinely missing / invalid / revoked. This is the only
        // case where 401 is the correct response.
        log({ stage: 'auth.missing' }, 'warn')
        return fail('Authentication required. Provide a valid Bearer API key in the Authorization header.', 401, {
          code: 'unauthenticated',
        })
      }
      if (requireAdmin && !user.isAdmin) {
        log({ stage: 'auth.not_admin' }, 'warn')
        return fail('An admin key is required for this operation.', 403, { code: 'admin_required' })
      }
      ctx.user = user

      // Per-key policy check (scope / collection / table / rate limit).
      if (opts.authorize) {
        const z = authorize(user, req, opts.authorize)
        if (!z.ok) {
          log({ stage: 'authz.denied', code: z.code }, 'warn')
          const headers: Record<string, string> = {}
          if (z.retryAfter) headers['Retry-After'] = String(z.retryAfter)
          return Response.json(
            { ok: false, error: z.message, code: z.code, requestId },
            withRequestId(requestId, { status: z.status, headers }),
          )
        }
      }
    }

    // Execute the handler.
    try {
      const response = await opts.handler(req, ctx)
      return response
    } catch (err) {
      // Last-ditch safety net: never let an exception escape as a 500 with a
      // stack trace. Always return a structured JSON error with the request
      // ID so the user can report it and the operator can grep it.
      const message = err instanceof Error ? err.message : 'Unexpected server error.'
      log({ stage: 'handler.exception', error: message, stack: err instanceof Error ? err.stack?.split('\n').slice(0, 5) : undefined }, 'error')
      return failWithCode(
        'internal_error',
        `An unexpected error occurred while processing your request. Reference: ${requestId}`,
        500,
      )
    }
  }
}

/**
 * Helper for routes that DON'T need auth (e.g. /api/health, /api/config).
 * Still gets request IDs + structured error handling.
 */
export function withPublicApiHandler(
  operation: string,
  handler: (req: NextRequest, ctx: ApiHandlerCtx) => Promise<Response> | Response,
): (req: NextRequest, params?: unknown) => Promise<Response> {
  return withApiHandler({ operation, requireAuth: false, handler })
}

// Re-export the underlying authorizeFailResponse for routes that haven't migrated.
export { authorizeFailResponse } from '@/lib/auth'

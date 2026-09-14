import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, fail, ok } from '@/lib/auth'
import { getKeyWithRehydrate } from '@/lib/kv'
import { resolveRequestId } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * GET /v1/get/[key]?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 * Response: { "ok": true, "value": 500, "type": "number", "collection": "default" }
 *
 * Read-your-writes: when the record misses locally (cold / stale serverless
 * instance), the account manifest is pulled from the durable Telegram mirror
 * and the lookup retried BEFORE answering 404. Auth failures are structured
 * (503 auth_backend_unavailable instead of an unhandled 500) so clients can
 * distinguish "temporary backend issue, retry" from "invalid key".
 *
 * Observability (PRD §34): every request emits ONE structured completion log
 * line — requestId, route, method, status, durationMs. The key NAME (first
 * 120 chars) is included because it is non-sensitive request metadata; the
 * VALUE is never logged.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const start = Date.now()
  const requestId = resolveRequestId(req.headers)
  const { key } = await params

  const done = (res: Response): Response => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        requestId,
        route: '/v1/get',
        method: 'GET',
        status: res.status,
        durationMs: Date.now() - start,
        operation: 'v1.get',
        key: key.slice(0, 120),
      }),
    )
    return res
  }

  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return done(auth.errorResponse)
  const user = auth.user

  const collection = req.nextUrl.searchParams.get('collection') || 'default'

  const z = authorize(user, req, { scope: 'read', collection })
  if (!z.ok) return done(authorizeFailResponse(z))

  const record = await getKeyWithRehydrate(user, key, collection)
  if (!record) {
    return done(fail(`Key "${key}" not found in collection "${collection}".`, 404))
  }
  return done(ok({ value: record.value, type: record.valueType, collection: record.collection, updatedAt: record.updatedAt }))
}

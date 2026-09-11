import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, fail, ok } from '@/lib/auth'
import { getKeyWithRehydrate } from '@/lib/kv'

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
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

  const { key } = await params
  const collection = req.nextUrl.searchParams.get('collection') || 'default'

  const z = authorize(user, req, { scope: 'read', collection })
  if (!z.ok) return authorizeFailResponse(z)

  const record = await getKeyWithRehydrate(user, key, collection)
  if (!record) {
    return fail(`Key "${key}" not found in collection "${collection}".`, 404)
  }
  return ok({ value: record.value, type: record.valueType, collection: record.collection, updatedAt: record.updatedAt })
}

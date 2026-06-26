import { NextRequest } from 'next/server'
import { authenticate, fail, ok } from '@/lib/auth'
import { getKey } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * GET /v1/get/[key]?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 * Response: { "ok": true, "value": 500, "type": "number", "collection": "default" }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { key } = await params
  const collection = req.nextUrl.searchParams.get('collection') || 'default'
  const record = await getKey(user, key, collection)
  if (!record) {
    return fail(`Key "${key}" not found in collection "${collection}".`, 404)
  }
  return ok({ value: record.value, type: record.valueType, collection: record.collection, updatedAt: record.updatedAt })
}

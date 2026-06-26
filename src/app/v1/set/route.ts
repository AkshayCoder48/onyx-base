import { NextRequest } from 'next/server'
import { authenticate, coerceValue, fail, ok } from '@/lib/auth'
import { setKey } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * POST /v1/set
 * Body: { "key": "coins", "value": 500, "collection"?: "default" }
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * The value is coerced: numbers, booleans, and JSON objects/arrays are parsed;
 * everything else is stored as a string.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return fail('Request body must be valid JSON.', 400)
  }

  const key = body.key
  const collection = (body.collection as string) || 'default'
  if (typeof key !== 'string' || !key.trim()) {
    return fail('`key` is required and must be a non-empty string.', 400)
  }
  if (body.value === undefined) {
    return fail('`value` is required.', 400)
  }

  // If value already came typed (JSON), keep it; else coerce from string.
  const isRawString = typeof body.value === 'string'
  const result = await setKey(user, {
    key,
    collection,
    source: 'api',
    json: isRawString ? coerceValue(body.value as string).value : body.value,
  })

  return ok({ key: result.key, value: result.value, type: result.valueType, collection: result.collection })
}

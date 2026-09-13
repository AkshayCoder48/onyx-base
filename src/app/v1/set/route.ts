import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, coerceValue, fail, ok } from '@/lib/auth'
import { lastThrottleInfo } from '@/lib/telegram'
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
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

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

  const z = authorize(user, req, {
    scope: 'write',
    collection,
    bytesWritten: Buffer.byteLength(JSON.stringify(body.value)),
  })
  if (!z.ok) return authorizeFailResponse(z)

  // If value already came typed (JSON), keep it; else coerce from string.
  const isRawString = typeof body.value === 'string'
  try {
    const result = await setKey(user, {
      key,
      collection,
      source: 'api',
      json: isRawString ? coerceValue(body.value as string).value : body.value,
    })

    const durable = result.durable === true
    // On failure, hand the client Telegram's own throttle (if observed on
    // this instance) so programmatic clients back off precisely instead of
    // hammering through it and escalating it into a ban.
    const throttle = durable ? undefined : (lastThrottleInfo() ?? undefined)
    return ok({
      key: result.key,
      value: result.value,
      type: result.valueType,
      collection: result.collection,
      durable,
      ...(throttle ? { throttle } : {}),
    })
  } catch (err) {
    // Legible 500s: surface the crash reason so failures are diagnosable
    // from the response alone (no log access in this environment).
    // Nested guard: error serialization itself must never throw (exotic
    // error objects with throwing stack getters would otherwise escape
    // as an opaque HTML 500).
    try {
      const msg = err instanceof Error ? err.message : String(err)
      let stackTop = ''
      try {
        stackTop = err instanceof Error ? (err.stack?.split('\n').slice(1, 3).join(' <- ') ?? '') : ''
      } catch {
        stackTop = ''
      }
      console.error(`[v1/set] crash for ${collection}/${key}:`, err)
      return fail(`set failed: ${msg}${stackTop ? ` (${stackTop.slice(0, 200)})` : ''}`, 500)
    } catch {
      return fail('set failed (unserializable error)', 500)
    }
  }
}

import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, fail, ok } from '@/lib/auth'
import { listKeysWithRehydrate } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * GET /v1/list?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Returns just the keys (compact, CLI-friendly). Use /v1/export for full values.
 *
 * Read-your-writes: an empty local view triggers ONE guarded rehydrate from
 * the durable Telegram mirror before answering, so a cold instance never
 * reports "0 keys" for a collection that has records. Auth failures are
 * structured (503 instead of an unhandled 500).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

  const collection = req.nextUrl.searchParams.get('collection') || undefined

  const z = authorize(user, req, { scope: 'read', ...(collection ? { collection } : {}) })
  if (!z.ok) return authorizeFailResponse(z)

  const records = await listKeysWithRehydrate(user, collection)
  return ok({ keys: records.map((r) => r.key), count: records.length })
}

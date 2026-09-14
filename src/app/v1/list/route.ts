import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, fail, ok } from '@/lib/auth'
import { listKeysWithRehydrate } from '@/lib/kv'
import { parsePagination, paginationMeta } from '@/lib/pagination'

export const runtime = 'nodejs'

/**
 * GET /v1/list?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Returns just the keys (compact, CLI-friendly). Use /v1/export for full values.
 *
 * Pagination (PRD §20 / RGE Hub PRD §14): optional `?limit=N&offset=M`
 * (limit 1..1000, offset >= 0; limit defaults to 100 when only offset is
 * given). When NEITHER param is present the response is the full key list —
 * byte-for-byte backward compatible. When either param is present, the keys
 * are returned in deterministic lexicographic order, sliced to the window,
 * and the response additionally carries `__pagination:
 * { total, limit, offset, hasMore }` (`count` always stays the TOTAL number
 * of keys in the collection, matching its legacy meaning).
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

  const { pagination, error: paginationError } = parsePagination(req.nextUrl.searchParams)
  if (paginationError) return fail(paginationError, 400)

  const records = await listKeysWithRehydrate(user, collection)
  const keys = records.map((r) => r.key)

  if (!pagination) {
    // Legacy mode (no limit/offset): full result, store order — unchanged.
    return ok({ keys, count: records.length })
  }

  // Paginated mode: deterministic sorted window + metadata.
  keys.sort()
  const slice = keys.slice(pagination.offset, pagination.offset + pagination.limit)
  return ok({
    keys: slice,
    count: records.length,
    __pagination: paginationMeta(records.length, pagination, slice.length),
  })
}

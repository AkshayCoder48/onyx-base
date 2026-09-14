import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, fail, ok } from '@/lib/auth'
import { exportData, logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'
import { parsePagination, paginationMeta } from '@/lib/pagination'

export const runtime = 'nodejs'

/**
 * GET /v1/export?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Returns the full database as a JSON object:
 * { "coins": 500, "theme": "dark", "premium": true, "users.score": 42 }
 *
 * Pagination (PRD §20 / RGE Hub PRD §14): optional `?limit=N&offset=M`
 * (limit 1..1000, offset >= 0; limit defaults to 100 when only offset is
 * given). When NEITHER param is present the response is the full export —
 * byte-for-byte backward compatible. When either param is present, the
 * object is rebuilt over the sorted key list sliced to the requested window,
 * plus a `__pagination: { total, limit, offset, hasMore }` field inside the
 * data object. NOTE: `__`-prefixed key names are reserved for such metadata —
 * a user record literally named `__pagination` would be shadowed in paginated
 * responses (unpaginated exports are untouched).
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

  const collection = req.nextUrl.searchParams.get('collection') || undefined

  const z = authorize(user, req, { scope: 'export', ...(collection ? { collection } : {}) })
  if (!z.ok) return authorizeFailResponse(z)

  const { pagination, error: paginationError } = parsePagination(req.nextUrl.searchParams)
  if (paginationError) return fail(paginationError, 400)

  const data = await exportData(user, collection)

  let out: Record<string, unknown> = data
  if (pagination) {
    // Paginated mode: deterministic sorted window + metadata field.
    const keys = Object.keys(data).sort()
    const slice = keys.slice(pagination.offset, pagination.offset + pagination.limit)
    out = {}
    for (const k of slice) out[k] = data[k]
    out.__pagination = paginationMeta(keys.length, pagination, slice.length)
  }

  const detail =
    (collection ? `collection=${collection}` : 'all') +
    (pagination ? ` limit=${pagination.limit} offset=${pagination.offset}` : '')
  await logAction(user, 'export', undefined, detail, 'api')
  void sendEventMessage({
    owner: user.userId,
    event: 'export',
    detail,
    source: 'api',
    ts: Math.floor(Date.now() / 1000),
  })
  return ok({ data: out })
}

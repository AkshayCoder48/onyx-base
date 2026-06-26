import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { listLogs } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /v1/logs — recent audit log entries for the authenticated developer.
 *
 * Query params:
 *   ?limit=50   — max entries to return (default 50, capped at 500).
 *   ?action=…   — filter by action (e.g. `kv.set`, `file.link`).
 *
 * Auth: `Authorization: Bearer kv_live_…`
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const limitParam = req.nextUrl.searchParams.get('limit')
  const actionFilter = req.nextUrl.searchParams.get('action')
  let limit = Number(limitParam)
  if (!Number.isFinite(limit) || limit <= 0) limit = 50
  if (limit > 500) limit = 500

  let logs = listLogs(user.dbUserId, { limit: limit * 5, action: actionFilter ?? undefined })
  logs = logs.slice(0, limit)

  return ok({
    logs: logs.map((l) => ({
      id: l.id,
      action: l.action,
      key: l.key,
      detail: l.detail,
      source: l.source,
      ip: l.ip,
      createdAt: l.createdAt,
    })),
    count: logs.length,
    filter: actionFilter ?? null,
  })
}

import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { listLogs } from '@/lib/data-store'

export const runtime = 'nodejs'

/** GET /api/dashboard/logs?limit=100 — recent audit log entries. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const limit = Math.min(Number(req.nextUrl.searchParams.get('limit')) || 100, 500)
  const action = req.nextUrl.searchParams.get('action') || undefined

  const logs = listLogs(user.dbUserId, { limit, action })
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
  })
}

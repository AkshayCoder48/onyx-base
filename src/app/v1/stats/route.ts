import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { getStats } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /v1/stats — account statistics for the authenticated developer.
 *
 * Returns counts (records, collections, apiKeys, logs, files), storage bytes,
 * file bytes, and 7-day activity breakdowns by day + by action.
 *
 * Auth: `Authorization: Bearer kv_live_…`
 */
export async function GET(req: NextRequest) {
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  return ok({ user: user.userId, stats: getStats(user.dbUserId) })
}

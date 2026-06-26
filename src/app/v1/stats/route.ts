import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
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
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  return ok({ user: user.userId, stats: getStats(user.dbUserId) })
}

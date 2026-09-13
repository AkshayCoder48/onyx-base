import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getAnalytics } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/analytics — usage analytics:
 *  - record count by collection
 *  - value-type distribution
 *  - top keys by recent activity
 *  - 14-day activity series
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const analytics = getAnalytics(user.dbUserId)

  return ok(analytics)
}

import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getStats } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/stats — high-level numbers for the dashboard overview.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const stats = getStats(user.dbUserId)

  return ok(stats)
}

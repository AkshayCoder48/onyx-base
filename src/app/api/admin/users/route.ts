import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { adminListAllUsers, adminGetGlobalStats } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/admin/users
 * Auth: Bearer onyxbase_...
 *
 * Returns ALL users with summary stats (records, collections, files, api keys).
 * This is the data behind the admin dashboard's user list.
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)
  return ok({
    users: adminListAllUsers(),
    stats: adminGetGlobalStats(),
  })
}

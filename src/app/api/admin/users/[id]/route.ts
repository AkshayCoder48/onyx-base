import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { adminGetUserDetail } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/admin/users/[id]
 * Auth: Bearer onyxbase_...
 *
 * Returns a single user's FULL data: collections, records, files, api keys,
 * and telegram config. This is what the admin sees when they tap a user.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)
  const { id } = await params
  const detail = adminGetUserDetail(id)
  if (!detail) return fail('User not found.', 404)
  return ok(detail)
}

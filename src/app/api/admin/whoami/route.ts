import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * GET /api/admin/whoami
 * Auth: Bearer onyxbase_...
 *
 * Confirms the caller is an admin. Used by the admin dashboard to validate
 * the session on page load. Returns 401 for non-admin keys.
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)
  return ok({
    isAdmin: true,
    userId: user.userId,
    apiKeyName: user.apiKeyName,
  })
}

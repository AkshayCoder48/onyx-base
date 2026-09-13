import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { adminListAdminKeys, adminRevokeAdminKey } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/admin/admins
 * Auth: Bearer onyxbase_...
 *
 * Returns all admin keys.
 */
export async function GET(req: NextRequest) {
  const admin = await authenticateAdmin(req.headers.get('authorization'))
  if (!admin) return fail('Unauthorized. Admin key required.', 401)
  return ok({ admins: adminListAdminKeys() })
}

/**
 * DELETE /api/admin/admins?id=<adminKeyId>
 * Auth: Bearer onyxbase_...
 *
 * Revoke an admin key (the bootstrap key cannot be revoked).
 */
export async function DELETE(req: NextRequest) {
  const admin = await authenticateAdmin(req.headers.get('authorization'))
  if (!admin) return fail('Unauthorized. Admin key required.', 401)
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return fail('Admin key id is required (?id=).', 400)
  const revoked = adminRevokeAdminKey(id)
  if (!revoked) return fail('Admin key not found or cannot be revoked (bootstrap key).', 404)
  return ok({ revoked: true })
}

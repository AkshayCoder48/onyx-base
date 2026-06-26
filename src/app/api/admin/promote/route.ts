import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { adminPromoteUser, adminListAdminKeys } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /api/admin/promote
 * Auth: Bearer onyxbase_...
 * Body: { "kvLiveKey": "kv_live_...", "label": "optional label" }
 *
 * Promote a regular user (identified by their kv_live API key) to admin.
 * Mints a new `onyxbase_<hex>` key for them and returns it. The promoted
 * user can then sign in to the admin dashboard with their new key.
 */
export async function POST(req: NextRequest) {
  const admin = await authenticateAdmin(req.headers.get('authorization'))
  if (!admin) return fail('Unauthorized. Admin key required.', 401)

  let kvLiveKey: string | undefined
  let label: string | undefined
  try {
    const body = await req.json()
    kvLiveKey = typeof body.kvLiveKey === 'string' ? body.kvLiveKey.trim() : undefined
    label = typeof body.label === 'string' ? body.label.trim() : undefined
  } catch {
    /* fall through */
  }

  if (!kvLiveKey) return fail('kvLiveKey is required.', 400)
  if (!kvLiveKey.startsWith('kv_live_')) {
    return fail('Expected a kv_live_* API key.', 400)
  }

  const newAdminKey = adminPromoteUser(kvLiveKey, label)
  if (!newAdminKey) {
    return fail('Invalid or revoked API key. No matching user found.', 404)
  }

  return ok({
    adminKey: newAdminKey.key,
    label: newAdminKey.label,
    createdAt: newAdminKey.createdAt,
    message: 'User promoted to admin. Share the onyxbase_ key with them — it grants full admin access.',
  })
}

/**
 * GET /api/admin/promote
 * Auth: Bearer onyxbase_...
 *
 * Returns all admin keys (including the bootstrap key). Used by the "All
 * Admins" panel in the admin dashboard.
 */
export async function GET(req: NextRequest) {
  const admin = await authenticateAdmin(req.headers.get('authorization'))
  if (!admin) return fail('Unauthorized. Admin key required.', 401)
  return ok({ admins: adminListAdminKeys() })
}

import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import {
  adminListAccountManifests,
  isV4ModeActive,
  adminListAllUsers,
  migrateV3ToV4,
  getAccountIndex,
} from '@/lib/data-store'
import { SYSTEM_ACCOUNT_ID } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * GET /api/admin/manifests
 * Auth: Bearer onyxbase_...
 *
 * Reports the per-account V4 manifest status: which accounts have manifests
 * pinned in Telegram, their message_id, byte size, record count, and last
 * sync time. Also reports whether the store is in V4 mode (index pinned) or
 * still on the legacy V3 full-state document.
 *
 * This is the data behind the admin panel's "Storage / Manifests" view.
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  // Explicitly ensure the V4 index has been probed (the cold-boot probe is
  // fire-and-forget and may not have completed yet on a fresh boot).
  await getAccountIndex().catch(() => null)
  const entries = await adminListAccountManifests()
  const v4 = isV4ModeActive()
  // Build a per-user view that joins the account index entry with the user
  // record (for name/email display).
  const users = adminListAllUsers()
  const userByUserId = new Map(users.map((u) => [u.userId, u]))
  const accounts = (entries ?? []).map((e) => {
    const u = userByUserId.get(e.userId)
    return {
      userId: e.userId,
      isSystem: e.userId === SYSTEM_ACCOUNT_ID,
      name: u?.name ?? (e.userId === SYSTEM_ACCOUNT_ID ? 'System (admin keys)' : null),
      email: u?.email ?? null,
      messageId: e.messageId,
      bytes: e.bytes,
      recordCount: e.recordCount,
      updatedAt: e.updatedAt,
    }
  })
  return ok({
    v4Mode: v4,
    storageMode: v4 ? 'v4-per-account' : 'v3-full-state',
    totalAccounts: accounts.length,
    totalBytes: accounts.reduce((s, a) => s + a.bytes, 0),
    accounts,
  })
}

/**
 * POST /api/admin/manifests
 * Auth: Bearer onyxbase_...
 *
 * Manually trigger the V3→V4 migration (splits the legacy full-state document
 * into per-account manifests + pins the V4 index). Idempotent — a no-op if
 * already in V4 mode. Used by the admin panel's "Migrate to per-account
 * storage" button.
 */
export async function POST(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)
  const result = await migrateV3ToV4()
  return ok({ result })
}

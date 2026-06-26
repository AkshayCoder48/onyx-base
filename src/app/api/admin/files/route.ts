import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { adminListAllFiles, adminGetGlobalStats } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/admin/files
 * Auth: Bearer onyxbase_...
 *
 * Returns ALL files across ALL users (with owner info). The admin file
 * browser uses this. Telegram download links are NOT included here — the
 * admin must tap "Get link" per file to mint one (on-demand, anti-spam).
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)
  return ok({
    files: adminListAllFiles(),
    stats: adminGetGlobalStats(),
  })
}

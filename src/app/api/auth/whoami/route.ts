import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { findUserByDbId } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/auth/whoami
 * Auth: Bearer kv_live_xxx
 *
 * Returns the identity of the currently authenticated developer. Used by the
 * dashboard to rehydrate a session from localStorage on page load.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)
  const dbUser = findUserByDbId(user.dbUserId)
  return ok({
    userId: user.userId,
    name: dbUser?.name ?? null,
    plan: dbUser?.plan ?? 'unlimited',
    apiKeyName: user.apiKeyName,
    isAdmin: user.isAdmin,
  })
}

import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { clearGmailTokens } from '@/lib/gmail-oauth'

export const runtime = 'nodejs'

/**
 * POST /api/admin/gmail/disconnect
 * Auth: Bearer onyxbase_...
 *
 * Clears the persisted Gmail OAuth2 refresh token. The system falls back to
 * the next provider (SMTP plain / Resend / dev mode) on the next send.
 *
 * This does NOT revoke access at Google's side — the admin should also
 * remove the app at https://myaccount.google.com/permissions if they want
 * to fully revoke.
 */
export async function POST(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  await clearGmailTokens()
  return ok({ disconnected: true })
}

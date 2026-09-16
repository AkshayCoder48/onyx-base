/**
 * GET /api/v5/accounts/whoami — resolve the caller's V5 account key.
 *
 * ACCOUNT-AUTH (bearer): works with ANY valid v5_accounts key — per-user
 * account keys (the RGE Hub "Reveal API key" keys) AND master/admin keys.
 * The RGE Hub's public API (/api/v1/*) calls this with the END USER's key
 * to resolve it to a userId before loading the user's profile/resources.
 *
 * Semantics are standard whoami: the caller already possesses the key, so
 * returning its owner identity leaks nothing (same contract as login).
 *
 * 200 { ok, data: { userId, name, email, role } }
 * 401 for unknown/revoked keys (the withV5Handler bearer gate).
 */
import { withV5Handler } from '@/lib/v5/handler'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withV5Handler({
  operation: 'accounts.whoami',
  auth: 'bearer',
  handler: async (_req, ctx) => {
    const user = ctx.user!
    // V5Account: `owner` (== `id`) is the account's stable userId (usr_*).
    return ctx.ok({
      userId: user.owner,
      name: user.name,
      email: user.email,
      role: user.role,
    })
  },
})

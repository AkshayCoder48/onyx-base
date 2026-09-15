/**
 * POST /api/v5/accounts/password — service endpoint for password updates.
 *
 * MASTER/ADMIN-ONLY (bearer auth + admin role): per-user keys must never
 * reach this route. The RGE Hub calls it with its master key AFTER the user
 * verified an email OTP (purpose=password_reset) and holds the hub-issued
 * signed resetToken — the user-facing proof lives in the Hub, this route is
 * the privileged write primitive.
 *
 * Body: { email, password }
 * 200 { ok, data: { userId, apiKey, name, email } } — fresh key, same account.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { v5UpdatePassword } from '@/lib/v5/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const POST = withV5Handler({
  operation: 'accounts.update_password',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    // Service endpoint: only master/admin keys (the Hub's master key).
    // v5AuthBearer maps master → role 'admin'; per-user accounts are 'user'.
    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Admin access required.', 401)
    }
    const body = (await req.json().catch(() => null)) as {
      email?: string
      password?: string
    } | null
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new V5Error('VALIDATION_ERROR', 'A valid email address is required.', 400)
    }
    if (password.length < 6) {
      throw new V5Error('VALIDATION_ERROR', 'Password must be at least 6 characters.', 400)
    }
    try {
      const account = await v5UpdatePassword(email, password)
      return ctx.ok(account)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'NOT_FOUND') {
        throw new V5Error('NOT_FOUND', 'No account exists with this email address.', 404)
      }
      throw err
    }
  },
})

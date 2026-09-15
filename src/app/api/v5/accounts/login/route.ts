/**
 * POST /api/v5/accounts/login — public login (docs/v5-contract.md §8).
 * Verifies credentials and mints a fresh API key (keys are re-mintable).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { v5Login } from '@/lib/v5/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const buckets = new Map<string, number[]>()
function rateLimited(ip: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now()
  const arr = (buckets.get(ip) ?? []).filter((t) => now - t < windowMs)
  if (arr.length >= max) {
    buckets.set(ip, arr)
    return true
  }
  arr.push(now)
  buckets.set(ip, arr)
  return false
}

export const POST = withV5Handler({
  operation: 'accounts.login',
  auth: 'none',
  handler: async (req: NextRequest, ctx) => {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (rateLimited(ip, 20)) {
      throw new V5Error('RATE_LIMITED', 'Too many login attempts — wait a minute.', 429)
    }
    const body = (await req.json().catch(() => null)) as { email?: string; password?: string } | null
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) {
      throw new V5Error('VALIDATION_ERROR', 'email and password are required.', 400)
    }
    try {
      const account = await v5Login(email, password)
      return ctx.ok(account)
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'AUTH_INVALID_CREDENTIALS') {
        throw new V5Error('AUTH_INVALID_CREDENTIALS', 'Invalid email or password.', 401)
      }
      throw err
    }
  },
})

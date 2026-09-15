/**
 * POST /api/v5/accounts — public account registration (docs/v5-contract.md §7).
 * Idempotent when an Idempotency-Key (or body requestId) is supplied.
 * Rate limited per IP.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { v5Register } from '@/lib/v5/auth'

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
  operation: 'accounts.register',
  auth: 'none',
  handler: async (req: NextRequest, ctx) => {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'
    if (rateLimited(ip, 10)) {
      throw new V5Error('RATE_LIMITED', 'Too many registration attempts — wait a minute.', 429)
    }
    const body = (await req.json().catch(() => null)) as {
      name?: string
      email?: string
      password?: string
      requestId?: string
    } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!name || !email || !password) {
      throw new V5Error('VALIDATION_ERROR', 'name, email, and password are required.', 400)
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new V5Error('VALIDATION_ERROR', 'A valid email address is required.', 400)
    }
    if (password.length < 6) {
      throw new V5Error('VALIDATION_ERROR', 'Password must be at least 6 characters.', 400)
    }
    const idemKey =
      req.headers.get('idempotency-key') ||
      (typeof body?.requestId === 'string' && /^[A-Za-z0-9._:-]{4,128}$/.test(body.requestId) ? body.requestId : undefined)
    try {
      const account = await v5Register({ name, email, password, idemKey })
      return ctx.ok(account, { status: 201 })
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code === 'EMAIL_TAKEN') throw new V5Error('EMAIL_TAKEN', 'This email is already registered.', 409)
      if (code === 'PAYLOAD_TOO_LARGE') throw new V5Error('VALIDATION_ERROR', String((err as Error).message), 400)
      throw err
    }
  },
})

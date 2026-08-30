import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { verifyOtp } from '@/lib/otp-store'

export const runtime = 'nodejs'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * POST /api/email-otp/verify
 * Body: { "email": "user@example.com", "code": "123456" }
 *
 * Verifies a 6-digit OTP previously issued via /api/email-otp/send.
 *
 * Auth: the caller must present the SAME Onyx Base API key that issued the
 * OTP. OTPs are scoped to the caller's account — tenant A cannot verify
 * an OTP issued by tenant B even if they know the email + code. This is
 * the correct security posture for an OTP service: the API key is the
 * tenant boundary.
 *
 * On success: { ok: true, verified: true }
 * On failure: { ok: false, error: "...", reason: "..." }
 *
 * Failure reasons:
 *   - not_found: no OTP issued for this email, or already consumed
 *   - expired: OTP TTL (10 min) elapsed
 *   - max_attempts: 5 wrong attempts → OTP voided
 *   - wrong_code: hash mismatch (attempts remaining: N)
 *
 * The response NEVER says "valid but expired" or "valid but consumed" —
 * both reduce to "not_found" so attackers can't distinguish them. This
 * is the standard pattern for OTP verification endpoints.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const code = typeof body.code === 'string' ? body.code.trim() : ''

  if (!email || !EMAIL_RE.test(email)) {
    return fail('A valid email address is required.', 400, { code: 'bad_email' })
  }
  if (!/^\d{6}$/.test(code)) {
    return fail('Code must be a 6-digit number.', 400, { code: 'bad_code' })
  }

  const result = verifyOtp(user.dbUserId, email, code)
  if (!result.ok) {
    // The reason is included for the developer's benefit — but the
    // "wrong_code" reason always says "invalid" in the public message
    // so attackers can't probe.
    const message =
      result.reason === 'expired'
        ? 'The code has expired. Please request a new one.'
        : result.reason === 'max_attempts'
          ? 'Too many wrong attempts. The code has been voided — please request a new one.'
          : 'Invalid or expired code.'
    return fail(message, 400, { code: 'invalid_otp', reason: result.reason })
  }

  return ok({ verified: true })
}

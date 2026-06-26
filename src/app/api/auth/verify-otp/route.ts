import { NextRequest } from 'next/server'
import { ok, fail, isValidEmail } from '@/lib/auth'
import { verifyOtp, OTP_PURPOSES, type OtpPurpose } from '@/lib/otp'
import { signResetToken } from '@/lib/reset-token'

export const runtime = 'nodejs'

/**
 * POST /api/auth/verify-otp
 * Body: { email: string, purpose: 'signup' | 'login' | 'reset', code: string }
 *
 * Verifies a 6-digit OTP that was previously issued by /api/auth/send-otp.
 * On success:
 *   - For purpose='signup' or 'login': returns `{ ok: true, verified: true }`.
 *     The frontend sets a local `otpVerified=true` flag and submits it with
 *     the subsequent /api/auth/register or /api/auth/login call.
 *   - For purpose='reset': mints a short-lived (10-min) signed `resetToken`
 *     bound to the email, and returns it. The reset-password endpoint
 *     requires this token — it's the proof that "this email was OTP-verified
 *     for reset at time T", so we don't need to keep the OTP record alive
 *     past its 10-minute TTL just to bridge the two calls.
 *
 * On any failure (not found / expired / consumed / wrong code), returns the
 * SAME generic `{ ok: false, error: 'Invalid or expired code.' }` so an
 * attacker can't enumerate which (e.g. "expired" vs "wrong code").
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    /* allow empty body */
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
  const rawPurpose = typeof body.purpose === 'string' ? body.purpose : ''
  const rawCode = typeof body.code === 'string' ? body.code.trim() : ''

  if (!rawEmail) return fail('Email is required.', 400)
  if (!isValidEmail(rawEmail)) {
    return fail('Please enter a valid email address.', 400)
  }
  if (!rawCode) return fail('Verification code is required.', 400)
  if (!OTP_PURPOSES.includes(rawPurpose as OtpPurpose)) {
    return fail(
      `Invalid purpose. Must be one of: ${OTP_PURPOSES.join(', ')}.`,
      400,
    )
  }
  const email = rawEmail.toLowerCase()
  const purpose = rawPurpose as OtpPurpose

  const result = verifyOtp(email, purpose, rawCode)
  if (!result.valid) {
    // Generic — never reveal whether the code was wrong, expired, or already used.
    return fail(result.reason || 'Invalid or expired code.', 400)
  }

  // For purpose='reset', mint a short-lived signed token the reset-password
  // endpoint will verify. This decouples OTP verification from password
  // update — the user can take a moment to type their new password without
  // the OTP record expiring under them.
  if (purpose === 'reset') {
    const { token } = signResetToken(email)
    return ok({ verified: true, resetToken: token, expiresInSeconds: 600 })
  }

  return ok({ verified: true })
}

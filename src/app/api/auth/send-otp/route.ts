import { NextRequest } from 'next/server'
import { ok, fail, isValidEmail } from '@/lib/auth'
import { findUserByEmail } from '@/lib/data-store'
import { createOtp, isOtpRateLimited, OTP_PURPOSES, type OtpPurpose } from '@/lib/otp'
import { sendOtpEmail, isSmtpConfigured } from '@/lib/email'

export const runtime = 'nodejs'

/**
 * POST /api/auth/send-otp
 * Body: { email: string, purpose: 'signup' | 'login' | 'reset' }
 *
 * Mints a 6-digit OTP, hashes it (scrypt) via createOtp, and either sends it
 * via SMTP (production) or surfaces it in the response as `devCode` (local
 * dev mode). This is the "local unlimited free" path — no SMTP provider
 * needed for the flow to work end-to-end in a fresh clone.
 *
 * Account-existence policy (intentionally different from /api/auth/login):
 *   - purpose='signup' → REFUSE if the email already exists (409). The user
 *     should sign in instead.
 *   - purpose='login' or 'reset' → REFUSE if NO account exists (404). A
 *     generic error would be confusing here — the user is actively asking to
 *     log in / reset, and a "no such account" message tells them to sign up
 *     first. (The /api/auth/login password endpoint stays generic to resist
 *     enumeration; this send-otp endpoint does not, by design.)
 *
 * Rate limiting: 5 OTP requests per email per 10 minutes (in-memory, rolling
 * window). Independent of any per-IP limit.
 *
 * Response (success):
 *   { ok: true, delivered: boolean, devMode: boolean, expiresInSeconds: 600,
 *     ...(devMode ? { devCode: string } : {}) }
 *
 * The `devCode` field is ONLY included when SMTP is NOT configured. In
 * production (SMTP configured), the code is delivered via email and never
 * appears in any API response.
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

  if (!rawEmail) return fail('Email is required.', 400)
  if (!isValidEmail(rawEmail)) {
    return fail('Please enter a valid email address (e.g. you@example.com).', 400)
  }
  const email = rawEmail.toLowerCase()

  // Validate purpose — must be one of the allowed enum values.
  if (!OTP_PURPOSES.includes(rawPurpose as OtpPurpose)) {
    return fail(
      `Invalid purpose. Must be one of: ${OTP_PURPOSES.join(', ')}.`,
      400,
    )
  }
  const purpose = rawPurpose as OtpPurpose

  // ── Account-existence gates (intentionally revealing — see header) ──
  const existingUser = findUserByEmail(email)
  if (purpose === 'signup' && existingUser) {
    return fail(
      'An account with this email already exists — use Sign in instead.',
      409,
      { existingUserId: existingUser.userId },
    )
  }
  if ((purpose === 'login' || purpose === 'reset') && !existingUser) {
    return fail(
      'No account found with this email. Sign up first.',
      404,
    )
  }

  // ── Rate limit: 5 per email per 10 min ──
  if (isOtpRateLimited(email)) {
    return fail(
      'Too many code requests for this email. Please wait a few minutes and try again.',
      429,
    )
  }

  // ── Mint + persist the OTP (hash only — plaintext stays in memory) ──
  const code = createOtp(email, purpose)

  // ── Deliver (SMTP) or surface (dev mode) ──
  const result = await sendOtpEmail({ to: email, code, purpose })

  // If SMTP is configured but delivery failed, surface that — don't pretend
  // success. The user can retry. We do NOT fall back to devCode in this case
  // (that would leak the code in production where the operator explicitly
  // configured SMTP).
  if (!result.delivered && !result.devMode) {
    return fail(
      result.message || 'Failed to send verification code. Please try again.',
      502,
    )
  }

  // Compose the response. devCode is ONLY included when devMode is true.
  return ok({
    delivered: result.delivered,
    devMode: result.devMode,
    expiresInSeconds: 600,
    ...(result.devMode ? { devCode: code } : {}),
    message: result.message,
  })
}

/**
 * Convenience GET so an operator can probe whether SMTP is configured without
 * sending a code. Returns `{ ok: true, smtpConfigured: boolean, devMode: boolean }`.
 * Useful for the admin dashboard's "OTP delivery" status indicator.
 */
export async function GET() {
  const configured = isSmtpConfigured()
  return ok({
    smtpConfigured: configured,
    devMode: !configured,
    message: configured
      ? 'SMTP is configured — OTP codes are delivered via email.'
      : 'SMTP is NOT configured — OTP codes are returned as devCode in the API response and logged to the server console (local dev mode).',
  })
}

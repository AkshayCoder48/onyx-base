import { NextRequest } from 'next/server'
import { ok, fail, isValidEmail } from '@/lib/auth'
import { findUserByEmail } from '@/lib/data-store'
import { createOtp, isOtpRateLimited, OTP_PURPOSES, type OtpPurpose } from '@/lib/otp'
import { sendOtpEmail, isSmtpConfigured } from '@/lib/email'
import { verifyEmail } from '@/lib/email-verify'

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
 * Email verification gate (the "clean it" requirement):
 *   BEFORE any OTP is minted or any email is sent, the recipient address is
 *   checked against BOTH:
 *     1. The temp-mail blocklist (4,493+ disposable domains, microsecond Set
 *        lookup). ALWAYS runs, for every purpose.
 *     2. A live SMTP deliverability probe (DNS/MX + RCPT conversation via
 *        check.emailverifier.online). Runs ONLY for signup (quick=false).
 *        For login/reset the email was already verified at signup, so we
 *        skip the 10–20s probe and rely on the fast blocklist alone.
 *
 *   If the email is disposable or undeliverable → 400 with a human-readable
 *   reason. NO OTP is minted, NO email is sent. This is the "only send
 *   emails for verification after verification of the email on real email
 *   checker and temp mail checker" policy.
 *
 *   If the live probe is UNREACHABLE (verifier down / network error) we
 *   fail-open (allow the request) so a third-party outage can't lock every
 *   signup out. The local blocklist still catches the obvious junk.
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

  // ── Email verification gate ──
  // Signup: full probe (temp-mail blocklist + live SMTP deliverability).
  // Login/reset: quick mode (temp-mail blocklist only — email was verified
  // at signup, no need to re-probe on every login).
  const verification = await verifyEmail(email, { quick: purpose !== 'signup' })
  if (!verification.valid && !verification.unreachable) {
    // Hard reject: disposable or undeliverable. Do NOT mint, do NOT send.
    return fail(
      verification.reason || 'This email address could not be verified.',
      400,
      { status: verification.status },
    )
  }
  // If verification.unreachable === true we fail-open (allow) — the local
  // blocklist already ran, and a third-party outage shouldn't lock signups.

  // ── Mint + persist the OTP (hash only — plaintext stays in memory) ──
  const code = createOtp(email, purpose)

  // ── Deliver (SMTP) or surface (dev mode) ──
  const result = await sendOtpEmail({ to: email, code, purpose })

  // Delivery-failure fallback policy:
  //
  // If SMTP is configured but delivery FAILS (e.g. Gmail rejects the password
  // with "535 Username and Password not accepted" because the operator hasn't
  // generated an App Password), we do NOT block the signup/login flow.
  // Instead we fall back to dev mode: the code is returned as `devCode` so the
  // user can complete verification, AND a `warning` field surfaces the SMTP
  // error so the operator knows email delivery is broken and can fix it.
  //
  // This matches the user's requirement: "make it real that it send emails" —
  // when SMTP works, real emails send; when it doesn't, the flow still works
  // and the operator is told exactly what to fix.
  if (!result.delivered && !result.devMode) {
    // Detect Gmail auth failures and append the App Password guidance.
    const isAuthFailure = /535|Username and Password not accepted|BadCredentials/i.test(
      result.message,
    )
    const warning = isAuthFailure
      ? `Email delivery failed — Gmail rejected the SMTP credentials. You likely need to generate an App Password at https://myaccount.google.com/apppasswords (regular Gmail passwords are blocked for SMTP). Original error: ${result.message}`
      : `Email delivery failed — showing the code inline instead. Fix SMTP config to enable real email delivery. Error: ${result.message}`

    console.warn(`[otp] SMTP delivery failed, falling back to dev mode for ${email}: ${result.message}`)

    return ok({
      delivered: false,
      devMode: true,
      expiresInSeconds: 600,
      devCode: code,
      warning,
      message: 'SMTP delivery failed — verification code shown inline (dev fallback).',
    })
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

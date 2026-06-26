import { NextRequest } from 'next/server'
import {
  generateUserId,
  ok,
  fail,
  authenticate,
  isValidEmail,
} from '@/lib/auth'
import { createUser, findUserByDbId, findUserByEmail } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'
import { verifyEmail } from '@/lib/email-verify'
import { validatePasswordStrength } from '@/lib/password'

export const runtime = 'nodejs'

/**
 * POST /api/auth/register
 * Body: { "name"?: "My App", "email"?: "me@example.com", "password"?: "secret", "source"?: "web" | "cli" }
 *
 * Mints a brand-new developer account and returns the public user id + a fresh
 * live API key. Used by:
 *   - the web dashboard signup form (name + email + password REQUIRED, email
 *     validated, password hashed and persisted to the Telegram cloud so it
 *     survives full local-store wipes)
 *   - the `cloudkv login` CLI command (name only, source=cli — no password)
 *
 * Email rules:
 *   - For `source=web`: email is REQUIRED and must pass strict validation +
 *     the tempmail-blocker local blocklist + a live SMTP deliverability probe.
 *     If the email already belongs to an existing account, we REFUSE to create
 *     a duplicate and tell the user to sign in instead.
 *   - For `source=cli`: email is optional (the CLI historically sends name only).
 *
 * Password rules:
 *   - For `source=web`: password is REQUIRED (min 6 chars). It is hashed with
 *     scrypt and stored as `passwordHash` on the user record. The hash is
 *     mirrored to the Telegram identity manifest alongside the rest of the
 *     user's details. The password is NEVER used for API operations — all KV
 *     ops still require the API key. The password exists solely so a user who
 *     has lost their API key can sign back in (POST /api/auth/login) and
 *     retrieve a working key.
 *   - For `source=cli`: password is optional (legacy CLI flow).
 *
 * Recovery path: if the caller already has a valid Bearer key, we re-print
 * their existing credentials instead of minting a new account.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    /* allow empty body */
  }

  const rawName = typeof body.name === 'string' ? body.name.trim() : ''
  const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
  const rawPassword = typeof body.password === 'string' ? body.password : ''
  const source = (typeof body.source === 'string' && body.source) || 'cli'
  const isWeb = source === 'web'
  const otpVerified = body.otpVerified === true
  const name = rawName || undefined

  // ── Web signups require a name ──
  if (isWeb && !rawName) {
    return fail('Please enter your name.', 400)
  }

  // ── Web signups MUST have completed email OTP verification ──
  // The frontend runs the send-otp + verify-otp flow BEFORE submitting the
  // signup form, then passes `otpVerified: true` to signal that the email is
  // confirmed. CLI signups skip this check (same as they skip email/password).
  if (isWeb && !otpVerified) {
    return fail(
      'Email verification required. Please request an OTP code and verify your email before signing up.',
      400,
    )
  }

  // ── Email validation ──
  // Web signups MUST supply a valid email. CLI signups may omit it.
  if (isWeb && !rawEmail) {
    return fail('Please enter your email address.', 400)
  }
  if (rawEmail && !isValidEmail(rawEmail)) {
    return fail(
      'Please enter a valid email address (e.g. you@example.com).',
      400,
    )
  }
  const email = rawEmail || undefined

  // ── Password validation (web signups only) ──
  // The password is the recovery credential — when a user loses their API key
  // they can sign back in with email + password to retrieve a working key.
  if (isWeb) {
    const pwErr = validatePasswordStrength(rawPassword)
    if (pwErr) return fail(pwErr, 400)
  }
  const password = rawPassword || undefined

  // ── Duplicate-account guard ──
  // If this email is already registered, do NOT create a second account.
  // Tell the user to sign in instead.
  if (email) {
    const existingUser = findUserByEmail(email)
    if (existingUser) {
      return fail(
        'An account with this email already exists. Use the "Sign in" tab — sign in with your API key, or with your email + password if you lost the key.',
        409,
        { existingUserId: existingUser.userId },
      )
    }
  }

  // ── Real mailbox verification (web signups only) ──
  // Two layers: (1) tempmail-blocker local blocklist (instant), then
  // (2) check.emailverifier.online live SMTP probe. Blocks bot abuse with
  // fake / non-existent / disposable addresses. CLI signups skip this. If the
  // live probe is unreachable, we fail open (allow the signup) so a
  // third-party outage doesn't lock everyone out.
  if (isWeb && email) {
    const verification = await verifyEmail(email)
    if (!verification.valid) {
      return fail(
        verification.reason || 'This email address could not be verified. Please use a valid, deliverable email.',
        400,
        { verificationStatus: verification.status },
      )
    }
  }

  // ── Recovery path: caller already has a valid key — re-print identity ──
  const existing = await authenticate(req.headers.get('authorization'))
  if (existing) {
    const user = findUserByDbId(existing.dbUserId)
    return ok({
      userId: user?.userId,
      apiKey: req.headers.get('authorization')?.replace(/^Bearer\s+/i, ''),
      recovered: true,
      message: 'Welcome back. Existing credentials re-printed.',
    })
  }

  const userId = generateUserId()
  const { user: dbUser, apiKeyRecord } = createUser({ userId, name, email, password })

  // Log the registration as a system action on the new user.
  const authed = {
    dbUserId: dbUser.id,
    userId: dbUser.userId,
    apiKeyId: apiKeyRecord.id,
    apiKeyName: apiKeyRecord.name,
  } as const
  await logAction(
    authed as never,
    'login',
    undefined,
    `account created via ${source}${email ? ` (${email})` : ''}`,
    source,
  )

  // Mirror the signup event to the Telegram backup channel.
  void sendEventMessage({
    owner: dbUser.userId,
    event: 'signup',
    detail: email ? `${name || 'anonymous'} · ${email}` : (name || 'anonymous'),
    source,
    ts: Math.floor(Date.now() / 1000),
  })

  return ok({
    userId: dbUser.userId,
    apiKey: apiKeyRecord.key,
    name: dbUser.name,
    email: dbUser.email,
    createdAt: dbUser.createdAt,
    message:
      'Account created. Keep your API key secret — it grants full access to your data. Your password is saved to the Telegram cloud so you can recover your key if you lose it.',
  })
}

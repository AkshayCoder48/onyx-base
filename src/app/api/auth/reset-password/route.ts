import { NextRequest } from 'next/server'
import { ok, fail, isValidEmail } from '@/lib/auth'
import { findUserByEmail, setUserPassword } from '@/lib/data-store'
import { validatePasswordStrength } from '@/lib/password'
import { verifyResetToken } from '@/lib/reset-token'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'
import { resolveChatId, resolveBotToken } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /api/auth/reset-password
 * Body: { email: string, resetToken: string, newPassword: string }
 *
 * Completes the password-reset flow. Requires a `resetToken` previously
 * minted by /api/auth/verify-otp (purpose='reset') — that token proves the
 * user received an OTP at this email within the last 10 minutes.
 *
 * Steps:
 *   1. Validate the token signature + expiry + that its baked-in email
 *      matches the submitted email (defends against token replay across
 *      accounts).
 *   2. Validate the new password strength (reuse `validatePasswordStrength`).
 *   3. Look up the user by email. If they don't exist (somehow — they
 *      existed when verify-otp ran, but accounts can be deleted), fail.
 *   4. Hash the new password (scrypt) via `setUserPassword` and persist.
 *   5. Log + mirror the event to Telegram (the user's own chat if configured).
 *
 * After a successful reset, the OTP-verified email-login path or the regular
 * email+password login both work with the new password.
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try {
    body = await req.json()
  } catch {
    /* allow empty body */
  }

  const rawEmail = typeof body.email === 'string' ? body.email.trim() : ''
  const rawToken = typeof body.resetToken === 'string' ? body.resetToken.trim() : ''
  const rawPassword = typeof body.newPassword === 'string' ? body.newPassword : ''

  if (!rawEmail) return fail('Email is required.', 400)
  if (!isValidEmail(rawEmail)) {
    return fail('Please enter a valid email address.', 400)
  }
  if (!rawToken) return fail('Reset token is required.', 400)
  const email = rawEmail.toLowerCase()

  // ── Verify the reset token ──
  // verifyResetToken checks signature + expiry AND that the email baked into
  // the token matches the email the user submitted. This stops an attacker
  // who intercepted one reset token from resetting a DIFFERENT account's
  // password (they'd need a token minted specifically for that email).
  const tokenCheck = verifyResetToken(email, rawToken)
  if (!tokenCheck.valid) {
    return fail(
      'Invalid or expired reset token. Please request a new code and try again.',
      401,
    )
  }

  // ── Validate the new password ──
  const pwErr = validatePasswordStrength(rawPassword)
  if (pwErr) return fail(pwErr, 400)

  // ── Look up the user (must exist — they existed when verify-otp ran) ──
  const user = findUserByEmail(email)
  if (!user) {
    // Race condition: account was deleted between verify-otp and reset-password.
    // Surface a generic error.
    return fail(
      'No account found with this email. The account may have been removed.',
      404,
    )
  }

  // ── Update the password (scrypt hash) ──
  const updated = setUserPassword(user.id, rawPassword)
  if (!updated) {
    return fail('Could not update password. Please try again.', 500)
  }

  // ── Log the reset event ──
  // We log on the user's own audit trail so they can see "password reset via
  // email OTP" in their activity log. No PII in the detail line.
  try {
    await logAction(
      {
        dbUserId: user.id,
        userId: user.userId,
        apiKeyId: 'system',
        apiKeyName: 'password-reset',
      } as never,
      'password_reset',
      undefined,
      'password reset via email OTP',
      'dashboard',
    )
  } catch (err) {
    // Logging is best-effort — never fail the reset because logging broke.
    console.error('[auth/reset-password] logAction failed:', err)
  }

  // Mirror to the user's own Telegram channel (if configured) — best-effort.
  try {
    void sendEventMessage(
      {
        owner: user.userId,
        event: 'password_reset',
        detail: 'via email OTP',
        source: 'dashboard',
        ts: Math.floor(Date.now() / 1000),
      },
      resolveChatId(user.id),
      resolveBotToken(user.id),
    )
  } catch (err) {
    console.error('[auth/reset-password] telegram mirror failed:', err)
  }

  return ok({
    message:
      'Password updated. You can now sign in with your new password.',
  })
}

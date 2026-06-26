/**
 * Onyx Base — short-lived signed tokens for the password-reset flow.
 *
 * Why a signed token instead of just trusting "the OTP was verified"?
 * Because the verify-otp and reset-password endpoints are SEPARATE calls,
 * and we don't want to keep OTP records alive past their 10-minute TTL just
 * to bridge the two calls. Instead, verify-otp mints a short-lived signed
 * token (this module) that proves "this email was OTP-verified for purpose
 * 'reset' at time T" — and reset-password verifies that token before
 * accepting the new password.
 *
 * Design mirrors `src/lib/download-token.ts`:
 *   - Token format: `<expiresAt>.<hexSig>`.
 *   - Sig = HMAC-SHA256(secret, `${email}:${expiresAt}`) — bound to the email
 *     so a token issued to alice@x.com can't be used to reset bob@y.com.
 *   - Verified with `timingSafeEqual` to resist timing attacks.
 *   - TTL 10 minutes (matches OTP TTL).
 *
 * Secret: `process.env.RESET_PASSWORD_SECRET || process.env.CLOUDKV_SECRET`.
 * RESET_PASSWORD_SECRET defaults to a non-empty dev value in .env.example so
 * the flow works in a fresh clone. If neither is set, we throw — same
 * fail-closed philosophy as download-token.ts.
 */

import crypto from 'crypto'

const RESET_TOKEN_TTL_MS = 10 * 60 * 1000

/**
 * Resolve the HMAC secret. Prefers RESET_PASSWORD_SECRET (isolated to the
 * reset flow, so rotating it doesn't invalidate download tokens or API keys)
 * and falls back to CLOUDKV_SECRET so operators with only one secret
 * configured still get a working flow.
 */
function getResetSecret(): string {
  const secret = process.env.RESET_PASSWORD_SECRET || process.env.CLOUDKV_SECRET || ''
  if (!secret) {
    throw new Error(
      'Reset-token signing requires RESET_PASSWORD_SECRET (or CLOUDKV_SECRET) to be set in .env. ' +
        'Refusing to sign/verify with a hard-coded fallback.',
    )
  }
  return secret
}

/** Mint a reset token bound to an email, expiring TTL_MS from now. */
export function signResetToken(email: string): { token: string; expiresAt: number } {
  const normalized = email.trim().toLowerCase()
  const expiresAt = Date.now() + RESET_TOKEN_TTL_MS
  const payload = `${normalized}:${expiresAt}`
  const sig = crypto.createHmac('sha256', getResetSecret()).update(payload).digest('hex')
  return { token: `${expiresAt}.${sig}`, expiresAt }
}

/**
 * Verify a reset token. Returns `{ valid: true, email }` only when:
 *   - the signature matches (token was minted by us, not forged), AND
 *   - the token hasn't expired, AND
 *   - the email argument matches the email baked into the token.
 *
 * The caller MUST pass the email they're trying to reset — we don't trust the
 * token alone, because that would let an attacker who intercepted one reset
 * token reset any email (we'd have no way to know which email they wanted).
 * The flow is: user enters email → server mints token bound to that email →
 * user submits reset with { email, resetToken, newPassword } → server verifies
 * the token AND that its baked-in email matches the submitted email.
 */
export function verifyResetToken(
  email: string,
  token: string,
): { valid: boolean; email?: string; expiresAt?: number } {
  if (!token || typeof token !== 'string') return { valid: false }
  const dot = token.indexOf('.')
  if (dot === -1) return { valid: false }

  const expiresAtStr = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt)) return { valid: false }

  const normalized = email.trim().toLowerCase()
  const expected = crypto
    .createHmac('sha256', getResetSecret())
    .update(`${normalized}:${expiresAt}`)
    .digest('hex')

  // Constant-time comparison.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return { valid: false }
  if (!crypto.timingSafeEqual(a, b)) return { valid: false }

  if (Date.now() >= expiresAt) return { valid: false }
  return { valid: true, email: normalized, expiresAt }
}

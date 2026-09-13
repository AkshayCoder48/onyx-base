/**
 * Onyx Base — password hashing & validation.
 *
 * Used by the email+password recovery login flow. Passwords are hashed with
 * scrypt (Node's built-in, no extra deps) and stored on the UserRecord as
 * `passwordHash`. The hash — along with the rest of the user's details — is
 * mirrored to the Telegram identity manifest so credentials survive full
 * local-store wipes (the same durability contract as API keys).
 *
 * API keys remain the ONLY credential needed for all KV operations
 * (set / get / delete / list / export). The password exists solely so a user
 * who has lost their API key can sign back in and retrieve a working key.
 */

import crypto from 'crypto'

const SCRYPT_KEYLEN = 64
// scrypt cost params: N=2^14 (standard), r=8, p=1. ~50ms per hash — fine for
// signup/login which are low-frequency operations.
const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 16384, r: 8, p: 1 }
const ALGO = 'scrypt'

/**
 * Hash a plaintext password using scrypt + a random salt.
 * Returns a self-describing string: `scrypt$<saltHex>$<hashHex>`.
 */
export function hashPassword(plain: string): string {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(plain, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS)
  return `${ALGO}$${salt.toString('hex')}$${hash.toString('hex')}`
}

/**
 * Verify a plaintext password against a stored scrypt hash.
 * Constant-time comparison via timingSafeEqual. Returns false on any error
 * (malformed hash, wrong password, etc.) — never throws.
 */
export function verifyPassword(plain: string, stored: string | null | undefined): boolean {
  if (!stored) return false
  try {
    const parts = stored.split('$')
    if (parts.length !== 3 || parts[0] !== ALGO) return false
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    if (salt.length === 0 || expected.length === 0) return false
    const actual = crypto.scryptSync(plain, salt, expected.length, SCRYPT_PARAMS)
    return crypto.timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

/**
 * Lightweight password strength check. We don't enforce draconian rules
 * (this is a recovery credential, not a bank password) but we require a
 * minimum length to resist trivial brute force. Returns '' when valid.
 */
export function validatePasswordStrength(plain: string): string {
  if (!plain) return 'Password is required.'
  if (plain.length < 6) return 'Password must be at least 6 characters.'
  if (plain.length > 256) return 'Password is too long (max 256 characters).'
  return ''
}

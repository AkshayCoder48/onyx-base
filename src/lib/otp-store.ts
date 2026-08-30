/**
 * Onyx Base — OTP (one-time password) store.
 *
 * Stores 6-digit OTP codes as user records so they ride the existing
 * persistence pipeline (cloudkv.json + Telegram manifest mirror + cold-boot
 * rehydrate). This means an OTP issued on one Vercel instance can be
 * verified on a different instance after a cold boot — the manifest is
 * the source of truth.
 *
 * Storage:
 *   collection: '__otp__'
 *   key:        'otp:<email>'     (lowercased)
 *   value:      JSON { hash, salt, expiresAt, attempts, createdAt }
 *
 * The OTP code itself is NEVER stored — only its SHA-256 hash with a
 * per-record random salt. Even if an attacker exfiltrates the cloudkv.json
 * file or the Telegram manifest, they cannot recover the code (and the
 * 10-minute TTL means brute force is impractical anyway).
 *
 * Brute-force protection:
 *   - `attempts` counter — after 5 failed verifies, the OTP is auto-voided.
 *   - TTL: 10 minutes from creation, then verify() always returns false.
 *   - Per-IP / per-email rate limit lives in the send route handler.
 */

import crypto from 'crypto'
import { upsertRecord, findRecord, deleteRecord } from '@/lib/data-store'

const COLLECTION = '__otp__'
const TTL_MS = 10 * 60 * 1000 // 10 minutes
const MAX_ATTEMPTS = 5

export interface OtpStoredValue {
  hash: string
  salt: string
  expiresAt: string
  attempts: number
  createdAt: string
}

export interface OtpIssueResult {
  code: string
  expiresAt: string
  recordKey: string
}

export interface OtpVerifyResult {
  ok: boolean
  reason: 'valid' | 'not_found' | 'expired' | 'max_attempts' | 'wrong_code'
}

function otpKey(email: string): string {
  return `otp:${email.trim().toLowerCase()}`
}

function hashOtp(code: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex')
}

/**
 * Generate a cryptographically random 6-digit OTP code.
 * Uses crypto.randomBytes (not Math.random) so the codes are not
 * predictable.
 */
export function generateOtpCode(): string {
  // 4 random bytes give us a 32-bit unsigned int. Modulo 1_000_000 to
  // map it into [0, 999999], then pad to 6 digits. The bias introduced by
  // modulo on a non-multiple of 2^32 is negligible (1 in ~4300).
  const n = crypto.randomBytes(4).readUInt32BE(0) % 1_000_000
  return n.toString().padStart(6, '0')
}

/**
 * Issue (create or replace) an OTP for the given email.
 * Returns the raw 6-digit code (to be sent via email) + the expiry time.
 *
 * Replaces any existing OTP for the same email — this is the standard
 * "request new code" behavior (if the user clicks "resend", the old code
 * is invalidated).
 */
export function issueOtp(
  dbUserId: string,
  publicUserId: string,
  email: string,
): OtpIssueResult {
  const code = generateOtpCode()
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = hashOtp(code, salt)
  const now = Date.now()
  const expiresAt = new Date(now + TTL_MS).toISOString()
  const value: OtpStoredValue = {
    hash,
    salt,
    expiresAt,
    attempts: 0,
    createdAt: new Date(now).toISOString(),
  }
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: otpKey(email),
    value: JSON.stringify(value),
    valueType: 'object',
  })
  return { code, expiresAt, recordKey: otpKey(email) }
}

/**
 * Verify an OTP. On success, the OTP is deleted (single-use).
 * On failure, the attempts counter is incremented (and the record is
 * deleted once MAX_ATTEMPTS is hit).
 *
 * Never throws — always returns a result object. The route handler decides
 * whether to surface the reason to the caller or just say "Invalid code".
 */
export function verifyOtp(
  dbUserId: string,
  email: string,
  code: string,
): OtpVerifyResult {
  const rec = findRecord(dbUserId, COLLECTION, otpKey(email))
  if (!rec) return { ok: false, reason: 'not_found' }

  let stored: OtpStoredValue
  try {
    stored = JSON.parse(rec.value) as OtpStoredValue
    if (!stored || typeof stored.hash !== 'string') {
      deleteRecord(dbUserId, COLLECTION, otpKey(email))
      return { ok: false, reason: 'not_found' }
    }
  } catch {
    deleteRecord(dbUserId, COLLECTION, otpKey(email))
    return { ok: false, reason: 'not_found' }
  }

  // Expiry check.
  const exp = Date.parse(stored.expiresAt)
  if (Number.isNaN(exp) || Date.now() > exp) {
    deleteRecord(dbUserId, COLLECTION, otpKey(email))
    return { ok: false, reason: 'expired' }
  }

  // Hash the input with the stored salt and compare.
  const inputHash = hashOtp(code.trim(), stored.salt)
  if (inputHash !== stored.hash) {
    stored.attempts = (stored.attempts ?? 0) + 1
    if (stored.attempts >= MAX_ATTEMPTS) {
      deleteRecord(dbUserId, COLLECTION, otpKey(email))
      return { ok: false, reason: 'max_attempts' }
    }
    // Persist the incremented attempt counter.
    upsertRecord(dbUserId, rec.userId, {
      collection: COLLECTION,
      key: otpKey(email),
      value: JSON.stringify(stored),
      valueType: 'object',
    })
    return { ok: false, reason: 'wrong_code' }
  }

  // Success — single-use, so delete immediately.
  deleteRecord(dbUserId, COLLECTION, otpKey(email))
  return { ok: true, reason: 'valid' }
}

/**
 * Delete (void) any existing OTP for the given email. Used by the dashboard
 * "revoke" action if the user wants to manually invalidate a pending OTP.
 */
export function voidOtp(dbUserId: string, email: string): boolean {
  return deleteRecord(dbUserId, COLLECTION, otpKey(email)) !== null
}

export const OTP_TTL_MS = TTL_MS
export const OTP_MAX_ATTEMPTS = MAX_ATTEMPTS

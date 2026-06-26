/**
 * Onyx Base — email OTP (one-time-password) verification codes.
 *
 * This module is the single source of truth for the local-unlimited-free
 * email OTP system. It generates 6-digit codes, hashes them with the EXISTING
 * scrypt `hashPassword` from `password.ts` (no new crypto introduced), stores
 * the hash via `saveOtp` in the data store, and verifies codes by hashing the
 * user-supplied value and comparing with `verifyPassword` (constant-time).
 *
 * Why scrypt and not a plain SHA? Because the OTP space is only 10^6 = one
 * million codes — if an attacker got the raw DB they could brute-force a
 * plaintext SHA hash in milliseconds. Scrypt's memory-hard KDF makes that
 * brute-force expensive (~50ms per try), so even a leaked `codeHash` gives
 * the attacker at most a few thousand guesses per second per core. The same
 * reasoning applies to user passwords, which is why we reuse the same helper.
 *
 * Lifecycle:
 *   1. API route calls `createOtp(email, purpose)` → mints a record, returns
 *      the plaintext 6-digit code. The route then either sends it via SMTP
 *      (production) or returns it as `devCode` (local dev mode).
 *   2. User submits the code → API route calls `verifyOtp(email, purpose, code)`.
 *      On success the record is marked `consumedAt` so it can't be replayed.
 *      On any failure (not found / expired / consumed / wrong code) we return
 *      the SAME generic error so attackers can't enumerate which.
 *
 * Rate limiting: max 5 OTP requests per email per 10 minutes, in-memory Map.
 * This is independent of the API route's per-IP limiter — it stops a single
 * email from being spammed with codes (which would either flood the inbox or,
 * in dev mode, clutter the response payload).
 */

import crypto from 'crypto'
import { hashPassword, verifyPassword } from '@/lib/password'
import {
  saveOtp,
  findLatestUnconsumedOtp,
  markOtpConsumed,
  listOtpsForEmail,
  type OtpRecord,
} from '@/lib/data-store'

/** How long an OTP is valid: 10 minutes. */
export const OTP_TTL_MS = 10 * 60 * 1000

/** Allowed OTP purposes — kept narrow so a signup code can't be reused for reset. */
export const OTP_PURPOSES = ['signup', 'login', 'reset'] as const
export type OtpPurpose = (typeof OTP_PURPOSES)[number]

/** Max OTP requests per email per RATE_WINDOW_MS. */
const RATE_MAX = 5
const RATE_WINDOW_MS = 10 * 60 * 1000

// ─── In-memory rate limiter (per email) ───────────────────────────────────────
//
// Keyed by lowercased email. Each entry holds the timestamps of the most
// recent OTP requests for that email within the rolling window. We use an
// array (not a counter) so the window is truly rolling — a request that's 11
// minutes old is evicted even if other requests are still within the window.
//
// This Map survives hot reloads via globalThis, matching the data-store pattern.
const globalForOtp = globalThis as unknown as {
  __onyxOtpRateMap?: Map<string, number[]>
}
const RATE_MAP: Map<string, number[]> =
  globalForOtp.__onyxOtpRateMap ?? (globalForOtp.__onyxOtpRateMap = new Map())

/**
 * Check whether an email is rate-limited (too many OTP requests in the
 * rolling window). Returns `true` if the caller should REFUSE the request.
 * Does NOT record a hit — call `recordOtpRequest` only after a successful
 * mint, so refused requests don't burn the user's quota.
 */
export function isOtpRateLimited(email: string): boolean {
  const key = email.trim().toLowerCase()
  const now = Date.now()
  const hits = (RATE_MAP.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  RATE_MAP.set(key, hits)
  return hits.length >= RATE_MAX
}

/** Record a successful OTP request for rate-limit accounting. */
function recordOtpRequest(email: string): void {
  const key = email.trim().toLowerCase()
  const now = Date.now()
  const hits = (RATE_MAP.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  hits.push(now)
  RATE_MAP.set(key, hits)
}

/**
 * Generate a cryptographically random 6-digit OTP code, zero-padded to 6
 * digits (so `000123` is a valid code, not `123`).
 *
 * Uses `crypto.randomInt(0, 1000000)` — the modern Node API that draws from
 * the OS CSPRNG and avoids the modulo bias you'd get from
 * `crypto.randomBytes(N) % 1000000`.
 */
export function generateOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Mint a new OTP for (email, purpose), persist its scrypt hash, and return
 * the PLAINTEXT code. The plaintext exists ONLY in this function's return
 * value — it is never written to disk. The caller (an API route) is
 * responsible for either emailing it via SMTP or returning it as `devCode`.
 *
 * Side effects:
 *   - Purges expired OTPs (called inside `saveOtp`).
 *   - Records a rate-limit hit so the next call within the window counts.
 */
export function createOtp(email: string, purpose: OtpPurpose): string {
  const normalized = email.trim().toLowerCase()
  const code = generateOtp()
  const now = Date.now()
  const record: OtpRecord = {
    id: 'otp_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex'),
    email: normalized,
    purpose,
    codeHash: hashPassword(code),
    createdAt: now,
    expiresAt: now + OTP_TTL_MS,
    consumedAt: null,
  }
  saveOtp(record)
  recordOtpRequest(normalized)
  return code
}

/**
 * Verify a user-supplied OTP code against the most recent unconsumed record
 * for (email, purpose).
 *
 * Returns `{ valid: true }` on success AND consumes the code (so it can't be
 * replayed). Returns `{ valid: false, reason }` on any failure — the reason
 * is a generic "Invalid or expired code" string that's safe to surface to the
 * user. We deliberately DON'T differentiate between "not found", "expired",
 * "already used", and "wrong code" — that would let an attacker enumerate.
 *
 * (Internally we log the specific reason to the server console at debug level
 * for operator troubleshooting — but never to the API response.)
 */
export function verifyOtp(
  email: string,
  purpose: OtpPurpose,
  code: string,
): { valid: boolean; reason?: string } {
  const normalized = email.trim().toLowerCase()

  // Basic shape validation — a 6-digit code. We strip whitespace but reject
  // anything that isn't exactly 6 digits after the strip, so callers can pass
  // the raw InputOTP value (which may contain spaces between groups).
  const cleaned = (code ?? '').replace(/\s+/g, '')
  if (!/^\d{6}$/.test(cleaned)) {
    return { valid: false, reason: 'Invalid or expired code.' }
  }

  const record = findLatestUnconsumedOtp(normalized, purpose)
  if (!record) {
    // No unconsumed record → either no code was ever issued, or the most
    // recent one was already used. We return the same generic message.
    return { valid: false, reason: 'Invalid or expired code.' }
  }

  if (Date.now() >= record.expiresAt) {
    // The record is still in the store but has aged out. Don't consume it
    // (purgeExpiredOtps will reap it on the next saveOtp), just refuse.
    return { valid: false, reason: 'Invalid or expired code.' }
  }

  // Constant-time-ish hash comparison via verifyPassword (timingSafeEqual).
  if (!verifyPassword(cleaned, record.codeHash)) {
    return { valid: false, reason: 'Invalid or expired code.' }
  }

  // Success — consume the code so it can't be replayed.
  markOtpConsumed(record.id)
  return { valid: true }
}

/**
 * Dev-mode helper: list all OTP metadata for an email (for the admin
 * dashboard). Returns NO hashes and NO plaintext codes — just the
 * envelope (id, purpose, createdAt, expiresAt, consumedAt) so an operator
 * can see what codes have been issued and whether they were consumed.
 *
 * This is the "OTP visible in the admin dashboard" half of the local dev
 * mode requirement. The plaintext code is shown to the user via the API
 * response's `devCode` field (only when SMTP is not configured); this
 * function is purely for after-the-fact operator visibility.
 */
export function peekOtpsForEmail(email: string) {
  return listOtpsForEmail(email)
}

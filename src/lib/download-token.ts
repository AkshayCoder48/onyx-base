/**
 * Onyx Base — time-limited, signed download tokens.
 *
 * WHY THIS EXISTS
 * ───────────────
 * Telegram's `getFile` API returns a temporary download URL that Telegram
 * revokes after ~1 hour. We expose that durability model to the user as a
 * "Get link" button: when they tap it, we mint a signed, 1-hour link on OUR
 * server. The link points at `/f/<fileId>?t=<sig>&e=<expiresAt>`, which:
 *
 *   1. works for BOTH public and private files (the signature is the credential),
 *   2. stops working after the expiry, so the user taps "Get link" again,
 *   3. never exposes the Telegram bot token (the URL is on our origin, and we
 *      proxy the bytes out of Telegram behind the scenes using a cached
 *      `getFile` URL — see telegram.ts).
 *
 * This is the anti-spam design the user asked for: a new Telegram `getFile`
 * call happens at most once per ~55 minutes per file (server-side cache), and
 * the user only triggers a *visible* "refresh" when their 1-hour link has
 * expired — never automatically.
 */

import crypto from 'crypto'

/**
 * The HMAC secret. We reuse the existing CLOUDKV_SECRET (already used to mint
 * API keys) so operators only configure one secret.
 *
 * SECURITY: No hard-coded fallback — if neither env var is set, token signing
 * and verification will throw. This is intentional: a baked-in dev secret would
 * let anyone forge download links against deployments where the operator forgot
 * to set the env var. Fail closed.
 */
function getDownloadSecret(): string {
  const secret = process.env.CLOUDKV_SECRET || process.env.DOWNLOAD_TOKEN_SECRET || ''
  if (!secret) {
    throw new Error(
      'Download-token signing requires CLOUDKV_SECRET (or DOWNLOAD_TOKEN_SECRET) to be set in .env. ' +
      'Refusing to sign/verify with a hard-coded fallback — that would be a security hole.'
    )
  }
  return secret
}

/** Default link lifetime: 55 minutes (just under Telegram's ~1-hour URL expiry). */
export const DOWNLOAD_LINK_TTL_MS = 55 * 60 * 1000

/**
 * Mint a signed download token for a file. Returns the token string + the
 * absolute expiry timestamp (epoch ms). The token is `expiresAt.hexsig` —
 * compact and URL-safe.
 */
export function signDownloadToken(fileId: string, expiresAt: number): string {
  const payload = `${fileId}:${expiresAt}`
  const sig = crypto.createHmac('sha256', getDownloadSecret()).update(payload).digest('hex')
  return `${expiresAt}.${sig}`
}

/**
 * Verify a signed download token for a file. Returns `true` only when:
 *   - the signature matches (token was minted by us, not forged), AND
 *   - the expiry has not passed.
 * Uses a constant-time comparison to avoid timing side-channels.
 */
export function verifyDownloadToken(fileId: string, token: string): { valid: boolean; expiresAt: number | null } {
  if (!token || typeof token !== 'string') return { valid: false, expiresAt: null }
  const dot = token.indexOf('.')
  if (dot === -1) return { valid: false, expiresAt: null }

  const expiresAtStr = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expiresAt = Number(expiresAtStr)
  if (!Number.isFinite(expiresAt)) return { valid: false, expiresAt: null }

  const expected = crypto.createHmac('sha256', getDownloadSecret()).update(`${fileId}:${expiresAt}`).digest('hex')

  // Constant-time comparison to resist timing attacks.
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return { valid: false, expiresAt: null }
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, expiresAt: null }

  if (Date.now() >= expiresAt) return { valid: false, expiresAt: null }
  return { valid: true, expiresAt }
}

/**
 * Convenience: mint a fresh token expiring `DOWNLOAD_LINK_TTL_MS` from now.
 * Returns both the token and the expiry, so callers can surface "expires in
 * ~1 hour" to the user.
 */
export function mintFreshDownloadToken(fileId: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + DOWNLOAD_LINK_TTL_MS
  return { token: signDownloadToken(fileId, expiresAt), expiresAt }
}

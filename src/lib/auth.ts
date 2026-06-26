/**
 * Onyx Base — authentication & id helpers.
 *
 * Identity model:
 *   - User.userId  : public, non-secret   e.g. `usr_8d72a`
 *   - ApiKey.key   : secret bearer token  e.g. `kv_live_abc123xyz`
 *
 * Every REST API request must carry `Authorization: Bearer kv_live_...`.
 * The dashboard uses the same key (pasted by the developer) to authenticate.
 *
 * Storage: in-memory store + JSON cache + Telegram mirror (see store.ts).
 * No Prisma, no SQLite.
 */

import { NextRequest } from 'next/server'
import { findUserByApiKey, rehydrateFromTelegram } from '@/lib/data-store'

export interface AuthenticatedUser {
  userId: string
  dbUserId: string
  apiKeyId: string
  apiKeyName: string
}

// Re-export the ID generators so routes can import everything from auth.ts.
export { generateUserId, generateApiKey } from '@/lib/data-store'

/**
 * Resolve a Bearer token to a user. Returns null when the key is missing,
 * malformed, revoked, or unknown. Touches `lastUsedAt` on success.
 *
 * Durability: if the key is not found locally, we make a best-effort attempt
 * to rehydrate the identity manifest from the Telegram pinned message (via
 * getChat) and retry. This is what makes API keys survive a full local-store
 * wipe — the manifest lives in Telegram and is fetched + matched on demand.
 */
export async function authenticate(
  authHeader: string | null,
): Promise<AuthenticatedUser | null> {
  if (!authHeader) return null
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim())
  if (!match) return null
  const token = match[1].trim()

  // Fast path: local lookup.
  let result = findUserByApiKey(token)
  if (result) {
    return {
      userId: result.user.userId,
      dbUserId: result.user.id,
      apiKeyId: result.apiKey.id,
      apiKeyName: result.apiKey.name,
    }
  }

  // Slow path: the key isn't in the local store. Try to fetch the identity
  // manifest from the Telegram pinned message and rehydrate, then retry.
  // This handles the "sandbox reset wiped db/cloudkv.json" case.
  try {
    const rehydrated = await rehydrateFromTelegram()
    if (rehydrated.attempted && (rehydrated.usersRestored || rehydrated.keysRestored)) {
      result = findUserByApiKey(token)
      if (result) {
        return {
          userId: result.user.userId,
          dbUserId: result.user.id,
          apiKeyId: result.apiKey.id,
          apiKeyName: result.apiKey.name,
        }
      }
    }
  } catch (err) {
    console.error('[auth] rehydrate-on-miss failed:', err)
  }

  return null
}

/** Detect the JSON-ish type of a value for storage + display. */
export function detectValueType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

/**
 * Strict email validation. Rejects disposable-looking junk, requires a real
 * domain with a dot, a TLD of 2+ letters, and no weird characters.
 *
 * Re-exported from the isomorphic `validate` module so the client and server
 * share the exact same rules.
 */
export { isValidEmail, emailValidationError } from '@/lib/validate'

/** Try to parse a string into a typed value (used by the CLI / set endpoint). */
export function coerceValue(raw: string): { value: unknown; type: string } {
  const trimmed = raw.trim()
  if (trimmed === '') return { value: '', type: 'string' }

  // booleans
  if (/^(true|false)$/i.test(trimmed)) {
    return { value: trimmed.toLowerCase() === 'true', type: 'boolean' }
  }
  // numbers
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed)
    return { value: num, type: 'number' }
  }
  // JSON
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      return { value: parsed, type: detectValueType(parsed) }
    } catch {
      /* fall through to string */
    }
  }
  return { value: trimmed, type: 'string' }
}

/** Standard JSON success response. */
export function ok(data: unknown, init?: ResponseInit) {
  return Response.json({ ok: true, ...data }, init)
}

/** Standard JSON error response. */
export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return Response.json({ ok: false, error: message, ...extra }, { status })
}

/**
 * Resolve the PUBLIC origin of this request — the URL an external client
 * (browser, CLI, anywhere on the internet) should use to reach us.
 *
 * This is critical for building permanent links (file downloadUrl, share
 * token readUrl/writeUrl) that MUST work from anywhere in the world, not just
 * from inside the server box.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_APP_URL` env var — explicit operator override (most reliable).
 *   2. `X-Forwarded-Proto` + `X-Forwarded-Host` — standard reverse-proxy headers
 *      (set by Caddy / Nginx / load balancers).
 *   3. `X-Forwarded-Proto` + `Host` header — the gateway forwards the real Host.
 *   4. `req.nextUrl.origin` — last-resort local fallback.
 *
 * Without this, behind the Caddy gateway `req.nextUrl.origin` resolves to
 * `http://localhost:3000`, which produces download links that work for nobody
 * (not even the creator, since their browser hits the cloud URL, not localhost).
 */
export function getPublicOrigin(req: NextRequest): string {
  // 1. Explicit env override (highest priority — operator sets the public URL).
  const envUrl = process.env.NEXT_PUBLIC_APP_URL || process.env.PUBLIC_BASE_URL
  if (envUrl) return envUrl.replace(/\/+$/, '')

  // 2/3. Derive from forwarded headers set by the gateway (Caddy / Nginx / LB).
  const headers = req.headers
  const fwdProto = headers.get('x-forwarded-proto')
  const proto = fwdProto ? fwdProto.split(',')[0].trim() : (req.nextUrl.protocol ? req.nextUrl.protocol.replace(':', '') : 'https')
  const fwdHost = headers.get('x-forwarded-host')
  const forwardedHost = fwdHost ? fwdHost.split(',')[0].trim() : null
  const host = forwardedHost || headers.get('host')
  if (host) return `${proto}://${host}`

  // 4. Local fallback.
  return req.nextUrl.origin
}

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
import {
  findUserByApiKey,
  rehydrateFromTelegram,
  findAdminKey,
  isAdminKey,
  getOrCreateAdminUser,
  findApiKeyRecord,
  type ApiKeyScope,
} from '@/lib/data-store'

export interface AuthenticatedUser {
  userId: string
  dbUserId: string
  apiKeyId: string
  apiKeyName: string
  /** True when authenticated via an `onyxbase_*` admin key. */
  isAdmin: boolean
}

// Re-export the ID generators so routes can import everything from auth.ts.
export { generateUserId, generateApiKey } from '@/lib/data-store'
export type { ApiKeyScope } from '@/lib/data-store'
export { ALL_API_KEY_SCOPES } from '@/lib/data-store'

// ─── Per-key rate limiters (in-memory, not persisted) ───────────────────────
//
// Two independent counters per API key:
//   1. Requests/min — sliding 60s window (for rateLimitPerMin).
//   2. MB written today — UTC-day cumulative bytes (for rateLimitMbPerDay).
//
// In-memory is fine here: a serverless cold boot resets these, but the worst
// case is a brief overage during a boot storm — acceptable for a per-key
// courtesy limiter (the real quota lives in the manifest).

/** key → array of request timestamps within the last 60s. */
const perMinBuckets = new Map<string, number[]>()

interface DailyBucket {
  /** UTC day key, e.g. '2026-06-28'. */
  day: string
  /** Cumulative bytes written today. */
  bytes: number
}

/** key → today's cumulative byte count (UTC). */
const perDayBuckets = new Map<string, DailyBucket>()

function todayUtcKey(): string {
  return new Date().toISOString().slice(0, 10)
}

function utcDayEndMs(): number {
  const now = new Date()
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0)
  return next
}

/**
 * Record a request hit for the per-minute limiter and return whether the key
 * is still under its quota. Returns `{ok:true}` when unlimited or under quota.
 */
function checkPerMin(key: string, limitPerMin: number | null | undefined): { ok: true } | { ok: false; retryAfter: number } {
  if (!limitPerMin || limitPerMin <= 0) return { ok: true }
  const now = Date.now()
  const windowMs = 60_000
  let hits = perMinBuckets.get(key) ?? []
  hits = hits.filter((t) => now - t < windowMs)
  if (hits.length >= limitPerMin) {
    perMinBuckets.set(key, hits)
    // Retry-After = seconds until the oldest hit in the window ages out.
    const oldest = hits[0]
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
    return { ok: false, retryAfter }
  }
  hits.push(now)
  perMinBuckets.set(key, hits)
  return { ok: true }
}

/**
 * Account `bytes` against the daily MB quota. Returns `{ok:true}` when
 * unlimited or still under quota; `{ok:false}` when adding the bytes would
 * exceed the limit (the bytes are NOT recorded in that case).
 */
function checkPerDay(
  key: string,
  bytes: number,
  limitMbPerDay: number | null | undefined,
): { ok: true } | { ok: false; retryAfter: number } {
  if (!limitMbPerDay || limitMbPerDay <= 0) return { ok: true }
  const today = todayUtcKey()
  const limitBytes = limitMbPerDay * 1024 * 1024
  let bucket = perDayBuckets.get(key)
  if (!bucket || bucket.day !== today) {
    bucket = { day: today, bytes: 0 }
    perDayBuckets.set(key, bucket)
  }
  if (bucket.bytes + bytes > limitBytes) {
    return { ok: false, retryAfter: Math.max(1, Math.ceil((utcDayEndMs() - Date.now()) / 1000)) }
  }
  bucket.bytes += bytes
  return { ok: true }
}

// ─── authorize() ────────────────────────────────────────────────────────────

export interface AuthorizeOptions {
  /** Required scope. Admin keys skip the scope check. */
  scope?: ApiKeyScope
  /** Collection being accessed (for collectionAllowList check). */
  collection?: string
  /** Table being accessed (for tableAllowList check). */
  table?: string
  /**
   * Bytes about to be WRITTEN by this request. Counted against
   * rateLimitMbPerDay. Set only on write paths (POST/PUT/PATCH/DELETE that
   * store data). 0 / omitted = read-only request.
   */
  bytesWritten?: number
}

export type AuthorizeResult =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string; retryAfter?: number }

/**
 * Enforce the API key's scope / expiry / allowlist / rate-limit policy AFTER
 * `authenticate()` has resolved the user. Admin keys bypass every check.
 *
 * Usage in a route:
 *   const user = await authenticate(req.headers.get('authorization'))
 *   if (!user) return fail('Unauthorized.', 401)
 *   const z = authorize(user, req, { scope: 'write', collection, bytesWritten: Buffer.byteLength(value) })
 *   if (!z.ok) return fail(z.message, z.status, { code: z.code, ...(z.retryAfter ? { 'Retry-After': String(z.retryAfter) } : {}) })
 *
 * `req` is used only to pull the raw Bearer token (to look up the full
 * ApiKeyRecord). For admin keys the lookup is skipped — admins are unlimited.
 */
export function authorize(
  user: AuthenticatedUser,
  req: NextRequest,
  opts: AuthorizeOptions = {},
): AuthorizeResult {
  // Admin keys bypass all per-key restrictions.
  if (user.isAdmin) return { ok: true }

  // Pull the raw token to fetch the full record (authenticate already did the
  // lookup but doesn't return the record — we do it again here. Cheap.)
  const auth = req.headers.get('authorization')
  const token = /^Bearer\s+(.+)$/i.exec((auth || '').trim())?.[1]?.trim()
  const rec = token ? findApiKeyRecord(token) : null

  // If we somehow can't find the record (e.g. just revoked between authenticate
  // and now), allow the request through — authenticate already verified it.
  // Per-key restrictions are a best-effort policy layer, not a security gate.
  if (!rec) return { ok: true }

  // Defensively default v3 fields — old keys created before scopes/rate-limits
  // (or restored from a v2 manifest) may have these as undefined. Treat missing
  // scopes/allowlists as empty (= full access), missing limits as null (= unlimited).
  const scopes: ApiKeyScope[] = Array.isArray(rec.scopes) ? rec.scopes : []
  const expiresAt: string | null = rec.expiresAt ?? null
  const collectionAllowList: string[] = Array.isArray(rec.collectionAllowList) ? rec.collectionAllowList : []
  const tableAllowList: string[] = Array.isArray(rec.tableAllowList) ? rec.tableAllowList : []
  const rateLimitPerMin: number | null = rec.rateLimitPerMin ?? null
  const rateLimitMbPerDay: number | null = rec.rateLimitMbPerDay ?? null

  // 1. Expiry.
  if (expiresAt) {
    const exp = Date.parse(expiresAt)
    if (!Number.isNaN(exp) && Date.now() > exp) {
      return { ok: false, status: 401, code: 'key_expired', message: 'API key has expired.' }
    }
  }

  // 2. Scope. Empty scopes array = full access (backward compat).
  if (opts.scope && scopes.length > 0 && !scopes.includes(opts.scope)) {
    return {
      ok: false,
      status: 403,
      code: 'insufficient_scope',
      message: `This API key does not have the "${opts.scope}" scope. Granted scopes: ${scopes.join(', ')}.`,
    }
  }

  // 3. Collection allowlist.
  if (opts.collection && collectionAllowList.length > 0 && !collectionAllowList.includes(opts.collection)) {
    return {
      ok: false,
      status: 403,
      code: 'collection_not_allowed',
      message: `This API key is restricted to collections: ${collectionAllowList.join(', ')}.`,
    }
  }

  // 4. Table allowlist.
  if (opts.table && tableAllowList.length > 0 && !tableAllowList.includes(opts.table)) {
    return {
      ok: false,
      status: 403,
      code: 'table_not_allowed',
      message: `This API key is restricted to tables: ${tableAllowList.join(', ')}.`,
    }
  }

  // 5. Rate limit — per minute (counted on every request, read or write).
  const perMin = checkPerMin(rec.key, rateLimitPerMin)
  if (!perMin.ok) {
    return {
      ok: false,
      status: 429,
      code: 'rate_limited',
      message: `Rate limit exceeded (${rateLimitPerMin} req/min). Retry after ${perMin.retryAfter}s.`,
      retryAfter: perMin.retryAfter,
    }
  }

  // 6. Rate limit — MB written per UTC day (only on write paths).
  if (opts.bytesWritten && opts.bytesWritten > 0) {
    const perDay = checkPerDay(rec.key, opts.bytesWritten, rateLimitMbPerDay)
    if (!perDay.ok) {
      return {
        ok: false,
        status: 429,
        code: 'daily_quota_exceeded',
        message: `Daily write quota (${rateLimitMbPerDay} MB/day) exceeded. Resets at UTC midnight.`,
        retryAfter: perDay.retryAfter,
      }
    }
  }

  return { ok: true }
}

/**
 * Build a Next.js Response for an authorize() failure. Sets the right status
 * + Retry-After header + JSON body.
 */
export function authorizeFailResponse(res: Exclude<AuthorizeResult, { ok: true }>): Response {
  const headers: Record<string, string> = {}
  if (res.retryAfter) headers['Retry-After'] = String(res.retryAfter)
  return Response.json(
    { ok: false, error: res.message, code: res.code },
    { status: res.status, headers },
  )
}

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

  // ─── Admin key path: onyxbase_* keys grant admin access ───────────────────
  // Admin keys map to a virtual admin user (id `admin`, userId `usr_admin`)
  // so the admin can also use the regular /v1/* and /api/* routes. The
  // `isAdmin: true` flag lets /api/admin/* routes gate on it.
  if (isAdminKey(token)) {
    const adminKey = findAdminKey(token)
    if (!adminKey) return null
    const adminUser = getOrCreateAdminUser()
    return {
      userId: adminUser.userId,
      dbUserId: adminUser.id,
      apiKeyId: adminKey.id,
      apiKeyName: adminKey.label,
      isAdmin: true,
    }
  }

  // ─── Regular key path: kv_live_* keys ─────────────────────────────────────
  // Fast path: local lookup.
  let result = findUserByApiKey(token)
  if (result) {
    return {
      userId: result.user.userId,
      dbUserId: result.user.id,
      apiKeyId: result.apiKey.id,
      apiKeyName: result.apiKey.name,
      isAdmin: false,
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
          isAdmin: false,
        }
      }
    }
  } catch (err) {
    console.error('[auth] rehydrate-on-miss failed:', err)
  }

  return null
}

/**
 * Authenticate AND require admin privileges. Returns null if the key is
 * missing, not an admin key, or revoked. Used by all /api/admin/* routes.
 */
export async function authenticateAdmin(
  authHeader: string | null,
): Promise<AuthenticatedUser | null> {
  const user = await authenticate(authHeader)
  if (!user || !user.isAdmin) return null
  return user
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

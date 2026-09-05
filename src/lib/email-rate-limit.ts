/**
 * Onyx Base — per-credential MCPEmail rate limiter (PRD §21 + "custom rate
 * limits on the MCPEmail service").
 *
 * THREE independent limiters guard the email automation API:
 *
 *   1. Platform-key limiter  — authorize() in auth.ts (rateLimitPerMin on
 *      the kv_live_* key). Applies to every request with that key.
 *   2. Per-IP limiter        — in the send routes (fixed default, spam guard).
 *   3. Per-CREDENTIAL limiter (THIS FILE) — the user-configurable custom rate
 *      limit stored on each credential record (`rateLimitPerMin`). Enforced
 *      immediately BEFORE the MCPEmail upstream call so a runaway automation
 *      script cannot burn the user's MCPEmail quota.
 *
 * All limiters are in-memory sliding windows. On serverless this is
 * best-effort per warm instance (a cold boot resets counters) — the same
 * trade-off the rest of the platform makes for its per-key limiters. The
 * credential limit is the user's own protection, not a billing gate.
 *
 * A hard platform ceiling (HARD_MAX_PER_MIN) caps how high a user can set
 * their custom limit, and also applies when the custom limit is null —
 * no single credential can push more than HARD_MAX_PER_MIN per minute per
 * instance even when "unlimited".
 */

/** Sliding-window buckets: `${dbUserId}:${credentialName}` → timestamps. */
const buckets = new Map<string, number[]>()

/** Platform hard ceiling per credential per minute (per instance). */
export const HARD_MAX_PER_MIN = 120

export interface RateCheck {
  ok: boolean
  /** Human-readable limit that applied (custom value or hard ceiling). */
  limit: number
  retryAfter: number
}

/**
 * Consume one slot for a credential send. Returns ok:false when the window
 * is exhausted — the caller MUST abort with 429 `rate_limited` BEFORE
 * calling MCPEmail.
 */
export function consumeCredentialRateLimit(
  dbUserId: string,
  credentialName: string,
  customLimitPerMin: number | null,
): RateCheck {
  const limit =
    customLimitPerMin != null && customLimitPerMin > 0
      ? Math.min(customLimitPerMin, HARD_MAX_PER_MIN)
      : HARD_MAX_PER_MIN
  const key = `${dbUserId}:${credentialName}`
  const now = Date.now()
  const windowMs = 60_000
  let hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) {
    buckets.set(key, hits)
    const oldest = hits[0]
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000))
    return { ok: false, limit, retryAfter }
  }
  hits.push(now)
  buckets.set(key, hits)
  return { ok: true, limit, retryAfter: 0 }
}

// Garbage-collect empty buckets once a minute (serverless-friendly).
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [k, hits] of buckets) {
      const fresh = hits.filter((t) => now - t < 60_000)
      if (fresh.length === 0) buckets.delete(k)
      else buckets.set(k, fresh)
    }
    for (const [k, hits] of ipBuckets) {
      const fresh = hits.filter((t) => now - t < IP_WINDOW_MS)
      if (fresh.length === 0) ipBuckets.delete(k)
      else ipBuckets.set(k, fresh)
    }
  }, 60_000).unref?.()
}

// ── Per-IP limiter for the send endpoints (spam guard, PRD §21) ────────────
// Default: 30 email-send requests per minute per client IP. Best-effort per
// warm instance (same trade-off as every other in-memory limiter here).

const ipBuckets = new Map<string, number[]>()
export const IP_WINDOW_MS = 60_000
export const IP_MAX_PER_WINDOW = 30

export function consumeIpRateLimit(
  ip: string,
  max = IP_MAX_PER_WINDOW,
): { ok: boolean; retryAfter: number } {
  const now = Date.now()
  let hits = (ipBuckets.get(ip) ?? []).filter((t) => now - t < IP_WINDOW_MS)
  if (hits.length >= max) {
    ipBuckets.set(ip, hits)
    const oldest = hits[0]
    return { ok: false, retryAfter: Math.max(1, Math.ceil((IP_WINDOW_MS - (now - oldest)) / 1000)) }
  }
  hits.push(now)
  ipBuckets.set(ip, hits)
  return { ok: true, retryAfter: 0 }
}

/** Extract the caller IP from proxy headers (best-effort). */
export function clientIpFrom(req: { headers: { get(name: string): string | null } }): string {
  return (
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  )
}

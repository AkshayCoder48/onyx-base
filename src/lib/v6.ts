/**
 * Onyx Base — V6 Ultima server primitives.
 *
 * V6 Ultima is the "nearly instant" access architecture:
 *
 *   1. ETag/304 revalidation on dashboard reads — when nothing changed, the
 *      server answers with an empty 304 instead of the full payload. That is
 *      the fastest possible round trip (no body, no serialization cost on
 *      the wire) and it is what makes repeated navigations feel instant.
 *
 *   2. /api/v6/boot — ONE request that returns everything the dashboard
 *      needs at boot (session, records, stats, analytics, collections,
 *      api keys, share tokens, recent logs). One function invocation instead
 *      of eight parallel ones — less cold-start amplification, less CPU.
 *      The response carries an ETag: when the client's cached copy is still
 *      current the server replies 304 and the client boots fully instantly
 *      from localStorage with ZERO parse cost.
 *
 *   3. /api/v6/batch — multiple operations in one round trip (used by the
 *      assistant and power flows to keep function invocations low).
 *
 * Correctness note on ETags: the tag is a SHA-256 of the exact response
 * body. Equal body ⇒ equal tag, different body ⇒ different tag (collision
 * odds are cryptographically negligible). This stays correct across a fleet
 * of serverless instances even when they are momentarily behind each other
 * — a stale instance produces a different body and therefore a different
 * tag, so it can never make a client keep wrong data.
 */

import crypto from 'crypto'

/** Canonical, stable JSON serialization (sorted object keys). */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(src).sort()) out[k] = sortValue(src[k])
    return out
  }
  return value
}

/**
 * Strong ETag for a payload: `"v6-<16 hex chars>"`.
 * Computed over the *canonical* serialization so semantically identical
 * payloads (differing only in key order) share a tag.
 */
export function etagFor(payload: unknown): string {
  const hash = crypto.createHash('sha256').update(stableJson(payload)).digest('hex')
  return `"v6-${hash.slice(0, 16)}"`
}

/** Cache policy for authenticated dashboard reads: always revalidate, enable 304s. */
export const V6_CACHE_CONTROL = 'private, no-cache, must-revalidate'

/**
 * Build a 200 response with ETag headers — or a 304 when the client's
 * If-None-Match still matches (instant revalidation, empty body).
 *
 * WIRE COMPATIBILITY: the payload is spread at the TOP level
 * (`{ ok: true, ...payload }`) — exactly like auth.ts `ok()` — so every
 * existing consumer (`api()` clients reading `stats.activityByDay`,
 * `records.records`, …) keeps working unchanged. The ETag covers only the
 * payload (the `ok` envelope is constant).
 */
export function v6Ok(payload: unknown, ifNoneMatch: string | null, status = 200): Response {
  const etag = etagFor(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': V6_CACHE_CONTROL,
    ETag: etag,
    Vary: 'Authorization',
  }
  // Handle both single tags and comma-separated lists (RFC 7232) plus `*`.
  const incoming = (ifNoneMatch || '').trim()
  if (incoming && (incoming === '*' || incoming.split(',').map((t) => t.trim()).includes(etag))) {
    return new Response(null, { status: 304, headers })
  }
  const body = JSON.stringify({ ok: true, ...(payload as Record<string, unknown>) })
  return new Response(body, { status, headers })
}

/**
 * Parse and validate a JSON request body. Returns `null` when the body is
 * absent/malformed (routes answer 400 themselves so error shapes stay
 * consistent with the rest of the app).
 */
export async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await req.text())
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

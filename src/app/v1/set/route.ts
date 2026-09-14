import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, coerceValue, fail, ok } from '@/lib/auth'
import { lastThrottleInfo } from '@/lib/telegram'
import { setKey } from '@/lib/kv'
import { resolveRequestId } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * POST /v1/set
 * Body: { "key": "coins", "value": 500, "collection"?: "default" }
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * The value is coerced: numbers, booleans, and JSON objects/arrays are parsed;
 * everything else is stored as a string.
 *
 * Idempotency (PRD §6-7): send an `Idempotency-Key` request header (alias
 * `X-Idempotency-Key`), shape /^[A-Za-z0-9._-]{8,128}$/.
 *   - First request with a key executes the write; the completed response
 *     (status < 500) is cached in-memory for 24h and replayed verbatim
 *     (same status + body, plus `Idempotent-Replayed: true`) on any retry
 *     with the SAME key — the write is NOT executed again.
 *   - A concurrent duplicate while the first is still executing gets
 *     409 { ok:false, error:'Idempotency-Key is currently being processed',
 *     retryable:true }.
 *   - 5xx responses are NOT cached; the in-flight marker is cleared so the
 *     client can cleanly retry the write.
 *   - IN-MEMORY ONLY, PER-INSTANCE (deliberately not persisted to Telegram):
 *     a retry that lands on a different serverless instance will re-execute.
 *     The write itself is an upsert, so re-execution converges to the same
 *     state; the cache exists to shield RGE Hub's "back off and retry after a
 *     timeout" behavior from double-writes and throttle escalation.
 *   - Entries are namespaced per user (`idem:{userId}:{key}`), capped at
 *     ~2000 entries with a lazy TTL sweep, so the registry can never grow
 *     unbounded.
 *
 * Omit the header entirely for the classic (non-idempotent-tracking)
 * behavior — fully backward compatible.
 */

// ─── Idempotency registry (module scope, per-instance, in-memory only) ──────

const IDEM_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/
const IDEM_TTL_MS = 24 * 60 * 60 * 1000 // completed responses replay for 24h
// A marker older than this means the executing request crashed without
// cleanup — treat the key as free again instead of 409-ing forever. Writes
// are hard-gated at 25s server-side, so 60s is a safe ceiling.
const IDEM_INFLIGHT_TTL_MS = 60 * 1000
const IDEM_MAX_ENTRIES = 2000

type IdemEntry =
  | { inflight: true; at: number }
  | { status: number; body: unknown; at: number }

// globalThis keeps the registry across Next.js dev hot reloads (same pattern
// as the data-store). Production module scope persists anyway.
const globalForIdem = globalThis as unknown as { __onyxSetIdem?: Map<string, IdemEntry> }
const idemStore: Map<string, IdemEntry> = globalForIdem.__onyxSetIdem ?? new Map()
globalForIdem.__onyxSetIdem = idemStore

let lastIdemSweepAt = 0

/** Lazy sweep: drop TTL-expired entries; if still over cap, evict the
 *  oldest-inserted (Map preserves insertion order ≈ creation order). */
function sweepIdemStore(now: number): void {
  lastIdemSweepAt = now
  for (const [k, v] of idemStore) {
    const ttl = 'inflight' in v ? IDEM_INFLIGHT_TTL_MS : IDEM_TTL_MS
    if (now - v.at > ttl) idemStore.delete(k)
  }
  while (idemStore.size >= IDEM_MAX_ENTRIES) {
    const oldest = idemStore.keys().next()
    if (oldest.done) break
    idemStore.delete(oldest.value)
  }
}

export async function POST(req: NextRequest) {
  const start = Date.now()
  const requestId = resolveRequestId(req.headers)
  // Key NAME only (non-sensitive metadata, truncated) — never the value,
  // never the bearer key, never auth headers. `idemLogKey` is the validated
  // client Idempotency-Key ([A-Za-z0-9._-] only — no secret shapes possible).
  let keyName: string | undefined
  let idemLogKey: string | undefined

  // One structured completion line per request (PRD §34 observability).
  const done = (res: Response): Response => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        requestId,
        route: '/v1/set',
        method: 'POST',
        status: res.status,
        durationMs: Date.now() - start,
        operation: 'v1.set',
        ...(keyName ? { key: keyName.slice(0, 120) } : {}),
        ...(idemLogKey ? { idemKey: idemLogKey.slice(0, 120) } : {}),
      }),
    )
    return res
  }

  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return done(auth.errorResponse)
  const user = auth.user

  // ── Idempotency-Key resolution + replay (before anything touches the store)
  const rawIdemKey = req.headers.get('idempotency-key') ?? req.headers.get('x-idempotency-key')
  let idemKey: string | null = null
  if (rawIdemKey !== null) {
    if (!IDEM_KEY_RE.test(rawIdemKey)) {
      return done(
        fail(
          '`Idempotency-Key` must be 8–128 chars of [A-Za-z0-9._-] (header alias `X-Idempotency-Key` is accepted).',
          400,
        ),
      )
    }
    idemKey = rawIdemKey
    idemLogKey = rawIdemKey
  }
  const idemCacheKey = idemKey ? `idem:${user.userId}:${idemKey}` : null

  if (idemCacheKey) {
    const now = Date.now()
    const existing = idemStore.get(idemCacheKey)
    if (existing && !('inflight' in existing)) {
      if (now - existing.at <= IDEM_TTL_MS) {
        // Replay: same status + body, write NOT executed again.
        return done(
          Response.json(existing.body, {
            status: existing.status,
            headers: { 'Idempotent-Replayed': 'true' },
          }),
        )
      }
      idemStore.delete(idemCacheKey) // expired — fall through and execute
    } else if (existing && now - existing.at <= IDEM_INFLIGHT_TTL_MS) {
      return done(fail('Idempotency-Key is currently being processed', 409, { retryable: true }))
    } else if (existing) {
      idemStore.delete(idemCacheKey) // stale in-flight marker — re-execute
    }
  }

  // Store the response on completion (status < 500); clear the marker on 5xx
  // so the client can retry cleanly.
  const finish = async (res: Response): Promise<Response> => {
    if (idemCacheKey) {
      if (res.status < 500) {
        let body: unknown
        try {
          body = await res.clone().json()
        } catch {
          body = { ok: false, error: 'response was not replayable JSON' }
        }
        idemStore.set(idemCacheKey, { status: res.status, body, at: Date.now() })
      } else {
        idemStore.delete(idemCacheKey)
      }
    }
    return done(res)
  }

  // Mark in-flight BEFORE executing, so a concurrent duplicate 409s instead
  // of double-writing.
  if (idemCacheKey) {
    const now = Date.now()
    if (now - lastIdemSweepAt > 60_000 || idemStore.size >= IDEM_MAX_ENTRIES) sweepIdemStore(now)
    idemStore.set(idemCacheKey, { inflight: true, at: now })
  }

  let collection = 'default'
  try {
    let body: Record<string, unknown>
    try {
      body = await req.json()
    } catch {
      return await finish(fail('Request body must be valid JSON.', 400))
    }

    const key = body.key
    collection = (body.collection as string) || 'default'
    if (typeof key !== 'string' || !key.trim()) {
      return await finish(fail('`key` is required and must be a non-empty string.', 400))
    }
    if (body.value === undefined) {
      return await finish(fail('`value` is required.', 400))
    }
    keyName = key

    const z = authorize(user, req, {
      scope: 'write',
      collection,
      bytesWritten: Buffer.byteLength(JSON.stringify(body.value)),
    })
    if (!z.ok) return await finish(authorizeFailResponse(z))

    // If value already came typed (JSON), keep it; else coerce from string.
    const isRawString = typeof body.value === 'string'
    const result = await setKey(user, {
      key,
      collection,
      source: 'api',
      json: isRawString ? coerceValue(body.value as string).value : body.value,
    })

    const durable = result.durable === true
    // On failure, hand the client Telegram's own throttle (if observed on
    // this instance) so programmatic clients back off precisely instead of
    // hammering through it and escalating it into a ban.
    const throttle = durable ? undefined : (lastThrottleInfo() ?? undefined)
    return await finish(
      ok({
        key: result.key,
        value: result.value,
        type: result.valueType,
        collection: result.collection,
        durable,
        ...(throttle ? { throttle } : {}),
      }),
    )
  } catch (err) {
    // Legible 500s: surface the crash reason so failures are diagnosable
    // from the response alone (no log access in this environment).
    // Nested guard: error serialization itself must never throw (exotic
    // error objects with throwing stack getters would otherwise escape
    // as an opaque HTML 500).
    // Also: a 5xx is never an idempotent completion — drop the in-flight
    // marker so a retry can re-execute instead of 409-ing until TTL.
    if (idemCacheKey) idemStore.delete(idemCacheKey)
    try {
      const msg = err instanceof Error ? err.message : String(err)
      let stackTop = ''
      try {
        stackTop = err instanceof Error ? (err.stack?.split('\n').slice(1, 3).join(' <- ') ?? '') : ''
      } catch {
        stackTop = ''
      }
      console.error(`[v1/set] crash for ${collection}/${keyName ?? '?'}:`, err)
      return done(fail(`set failed: ${msg}${stackTop ? ` (${stackTop.slice(0, 200)})` : ''}`, 500))
    } catch {
      return done(fail('set failed (unserializable error)', 500))
    }
  }
}

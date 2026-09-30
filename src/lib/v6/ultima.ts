'use client'

/**
 * Onyx Base — V6 Ultima client engine.
 *
 * The instant-access data layer:
 *
 *   1. INSTANT PAINT  — the last boot payload is persisted in localStorage
 *      and seeded into the React Query cache SYNCHRONOUSLY, before the
 *      dashboard renders. Tabs open with data on screen at frame one —
 *      no spinners, no skeleton shuffles.
 *
 *   2. ONE BOOT REQUEST — /api/v6/boot returns everything in one round
 *      trip and answers 304 (empty body) when the cached copy is still
 *      current: a "fully instant" boot with zero payload transfer.
 *
 *   3. INSTANT SEARCH — records/logs live fully client-side after boot;
 *      collection filters and search boxes are pure derived computations
 *      (zero network per keystroke).
 *
 *   4. OPTIMISTIC WRITES — set/delete update the local cache first (the
 *      UI reflects the change instantly), the network confirms after,
 *      and any failure rolls the cache back to the exact snapshot.
 *
 * Zero server-side assistant state: this module + the agent run entirely
 * in the browser. The deployment provider only ever sees the same REST
 * calls the dashboard itself makes.
 */

import type { QueryClient } from '@tanstack/react-query'
import type { RecordView } from '@/lib/api'

/* ────────────────────────────────────────────────────────────────────────────
 * Boot payload types (mirrors GET /api/v6/boot)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface V6BootPayload {
  v: 6
  arch: 'ultima'
  session: {
    userId: string
    apiKeyName: string
    isAdmin: boolean
    counts: { records: number; collections: number; apiKeys: number; logs: number }
  }
  records: { records: RecordView[]; count: number }
  stats: {
    records: number
    collections: number
    apiKeys: number
    logs: number
    storageBytes: number
    files: number
    fileBytes: number
    activityByDay: Record<string, number>
    activityByAction: Record<string, number>
  }
  analytics: {
    byCollection: Array<{ name: string; records: number }>
    byType: Array<{ type: string; count: number }>
    series: Array<{ day: string; count: number }>
    topKeys: Array<{ key: string; count: number }>
    totalEvents: number
  }
  collections: { collections: Array<{ id: string; name: string; records: number; createdAt: string }> }
  apiKeys: { apiKeys: unknown[] }
  shareTokens: { shareTokens: unknown[] }
  logs: { logs: Array<{ id: string; action: string; key: string | null; detail: string | null; source: string | null; ip: string | null; createdAt: string }> }
  files: { count: number; bytes: number }
}

/* ────────────────────────────────────────────────────────────────────────────
 * localStorage persistence (namespaced per user — sessions never bleed)
 * ──────────────────────────────────────────────────────────────────────────── */

interface StoredBoot {
  etag: string | null
  savedAt: number
  payload: V6BootPayload
}

const BOOT_STORE_PREFIX = 'v6:boot:'

function bootStoreKey(userId: string): string {
  return `${BOOT_STORE_PREFIX}${userId}`
}

function readStoredBoot(userId: string): StoredBoot | null {
  try {
    const raw = localStorage.getItem(bootStoreKey(userId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredBoot
    if (!parsed?.payload || parsed.payload?.v !== 6) return null
    return parsed
  } catch {
    return null
  }
}

function writeStoredBoot(userId: string, boot: StoredBoot): void {
  try {
    localStorage.setItem(bootStoreKey(userId), JSON.stringify(boot))
  } catch {
    /* quota exceeded / private mode — persistence is best-effort */
  }
}

export function clearV6Cache(userId?: string | null): void {
  try {
    if (userId) {
      localStorage.removeItem(bootStoreKey(userId))
    } else {
      const doomed: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(BOOT_STORE_PREFIX)) doomed.push(k)
      }
      for (const k of doomed) localStorage.removeItem(k)
    }
  } catch {
    /* ignore */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Cache seeding
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Seed every dashboard query cache from a boot payload.
 * `updatedAt` controls staleness — pass the ORIGINAL save time for
 * hydration (old data = stale = background refetch) or `Date.now()` to
 * mark everything fresh (used when the server 304s our boot ETag).
 */
export function seedCachesFromBoot(qc: QueryClient, payload: V6BootPayload, updatedAt: number): void {
  const put = (key: readonly unknown[], data: unknown) => {
    qc.setQueryData(key, data, { updatedAt })
  }
  put(['records'], payload.records)
  put(['stats'], payload.stats)
  put(['analytics'], payload.analytics)
  put(['collections'], payload.collections)
  put(['api-keys'], payload.apiKeys)
  put(['share-tokens'], payload.shareTokens)
  put(['logs'], payload.logs)
}

/**
 * Synchronously hydrate the query cache from localStorage. Call this
 * BEFORE the dashboard renders (e.g. in the QueryClient's initializer) —
 * components then mount with data already present.
 */
export function hydrateFromStorage(userId: string, qc: QueryClient): StoredBoot | null {
  const stored = readStoredBoot(userId)
  if (!stored) return null
  seedCachesFromBoot(qc, stored.payload, stored.savedAt)
  return stored
}

/* ────────────────────────────────────────────────────────────────────────────
 * The boot round trip (ETag-revalidated)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface V6BootResult {
  status: 'fresh-304' | 'updated-200' | 'offline'
  payload: V6BootPayload | null
}

/**
 * One round trip to /api/v6/boot with `If-None-Match`. 200 → seed + persist
 * the new payload; 304 → the cached payload is still current, re-stamp it
 * fresh. Network failure → keep whatever we have (offline-tolerant).
 */
export async function runV6Boot(
  userId: string,
  apiKey: string,
  qc: QueryClient,
): Promise<V6BootResult> {
  const stored = readStoredBoot(userId)
  let etag = stored?.etag ?? null
  if (!etag && stored) {
    // Older cache without an etag — derive one lazily so the NEXT boot can 304.
    etag = null
  }

  let res: Response
  try {
    res = await fetch('/api/v6/boot', {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
    })
  } catch {
    return { status: 'offline', payload: stored?.payload ?? null }
  }

  if (res.status === 304) {
    if (stored) {
      const now = Date.now()
      seedCachesFromBoot(qc, stored.payload, now)
      writeStoredBoot(userId, { ...stored, savedAt: now })
      return { status: 'fresh-304', payload: stored.payload }
    }
    // 304 without a local copy is a protocol oddity — fall through to refetch.
    const refetch = await fetch('/api/v6/boot', { headers: { Authorization: `Bearer ${apiKey}` } })
    if (!refetch.ok) return { status: 'offline', payload: null }
    const body = (await refetch.json()) as V6BootResponse
    if (!body.ok) return { status: 'offline', payload: null }
    return finishBoot(userId, qc, bootPayloadOf(body), refetch.headers.get('etag'))
  }

  if (!res.ok) return { status: 'offline', payload: stored?.payload ?? null }

  const body = (await res.json()) as V6BootResponse
  if (!body.ok) return { status: 'offline', payload: stored?.payload ?? null }
  return finishBoot(userId, qc, bootPayloadOf(body), res.headers.get('etag'))
}

/** Wire shape of /api/v6/boot: top-level spread (v6Ok), not a data wrapper. */
type V6BootResponse = V6BootPayload & { ok: true }

function bootPayloadOf(body: V6BootResponse): V6BootPayload {
  const { ok: _ok, ...payload } = body
  void _ok
  return payload
}

function finishBoot(
  userId: string,
  qc: QueryClient,
  payload: V6BootPayload,
  etag: string | null,
): V6BootResult {
  const now = Date.now()
  seedCachesFromBoot(qc, payload, now)
  writeStoredBoot(userId, { etag, savedAt: now, payload })
  return { status: 'updated-200', payload }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Optimistic mutations
 * ──────────────────────────────────────────────────────────────────────────── */

type ApiFn = <T = unknown>(path: string, opts?: RequestInit) => Promise<T>

function detectType(value: unknown): string {
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  if (Array.isArray(value)) return 'array'
  if (value && typeof value === 'object') return 'object'
  return 'string'
}

/** Invalidate the derived views after any record mutation (background). */
function invalidateRecordViews(qc: QueryClient): void {
  qc.invalidateQueries({ queryKey: ['stats'] })
  qc.invalidateQueries({ queryKey: ['logs'] })
  qc.invalidateQueries({ queryKey: ['collections'] })
  qc.invalidateQueries({ queryKey: ['analytics'] })
}

/**
 * Create/update a record OPTIMISTICALLY: the ['records'] cache updates
 * immediately, the POST confirms in the background, failures roll back to
 * the exact pre-mutation snapshot.
 */
export async function optimisticSetRecord(
  api: ApiFn,
  qc: QueryClient,
  opts: { key: string; value: unknown; collection?: string },
): Promise<{ record: RecordView & { durable?: boolean } }> {
  const recordsKey = ['records'] as const
  const collection = opts.collection || 'default'
  const before = qc.getQueryData<{ records: RecordView[] }>(recordsKey)

  // 1) local echo — the UI reflects the write at frame one
  const existing = before?.records.find((r) => r.key === opts.key && r.collection === collection)
  const optimistic: RecordView = {
    key: opts.key,
    value: opts.value,
    valueType: detectType(opts.value),
    collection,
    updatedAt: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  if (before) {
    const next = [
      ...before.records.filter((r) => !(r.key === opts.key && r.collection === collection)),
      optimistic,
    ]
    qc.setQueryData(recordsKey, { records: next, count: next.length }, { updatedAt: Date.now() })
  }

  try {
    // 2) network confirm
    const res = await api<{ record: RecordView & { durable?: boolean } }>('/api/dashboard/records', {
      method: 'POST',
      body: JSON.stringify({ key: opts.key, value: opts.value, collection }),
    })
    // 3) reconcile with the server's truth
    const cur = qc.getQueryData<{ records: RecordView[] }>(recordsKey)
    if (cur) {
      const next = [
        ...cur.records.filter((r) => !(r.key === opts.key && r.collection === collection)),
        res.record,
      ]
      qc.setQueryData(recordsKey, { records: next, count: next.length }, { updatedAt: Date.now() })
    }
    invalidateRecordViews(qc)
    return res
  } catch (err) {
    // 4) rollback to the snapshot
    if (before) qc.setQueryData(recordsKey, before, { updatedAt: Date.now() })
    throw err
  }
}

/**
 * Delete a record OPTIMISTICALLY (same snapshot/rollback contract).
 */
export async function optimisticDeleteRecord(
  api: ApiFn,
  qc: QueryClient,
  opts: { key: string; collection?: string },
): Promise<void> {
  const recordsKey = ['records'] as const
  const collection = opts.collection || 'default'
  const before = qc.getQueryData<{ records: RecordView[] }>(recordsKey)

  if (before) {
    const next = before.records.filter((r) => !(r.key === opts.key && r.collection === collection))
    qc.setQueryData(recordsKey, { records: next, count: next.length }, { updatedAt: Date.now() })
  }

  try {
    await api(
      `/api/dashboard/records/${encodeURIComponent(opts.key)}?collection=${encodeURIComponent(collection)}`,
      { method: 'DELETE' },
    )
    invalidateRecordViews(qc)
  } catch (err) {
    if (before) qc.setQueryData(recordsKey, before, { updatedAt: Date.now() })
    throw err
  }
}

/**
 * V6 batch call — the assistant's low-invocation transport. Returns the
 * per-op results array.
 */
export async function v6Batch(
  apiKey: string,
  ops: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch('/api/v6/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ops }),
  })
  const body = (await res.json().catch(() => null)) as
    | { ok: boolean; results?: Array<Record<string, unknown>>; error?: string }
    | null
  if (!res.ok || !body?.ok) {
    throw new Error(body?.error || `Batch failed (${res.status})`)
  }
  // withApiHandler's ok() spreads the payload at the TOP level:
  // { ok, requestId, results } — not nested under `data`.
  return body.results ?? []
}

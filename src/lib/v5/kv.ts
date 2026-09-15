/**
 * OnyxBase V5 — KV engine (docs/v5-contract.md §1-6).
 *
 * Authoritative SQLite upserts in ONE atomic batch; per-key hot cache with
 * event-driven invalidation; transactionally maintained live counters.
 * Values ≤ 256 KB (larger payloads belong in blobs).
 */

import { v5db, nowMs, num } from './db'
import { emitEvent, registerCacheSweep } from './events'

export const MAX_VALUE_BYTES = 256 * 1024

/** Fire-and-forget Telegram backup mirror (best-effort, never in-request).
 *  The v5_blobmeta collection is EXEMPT: its durability rides the small
 *  blobs-snapshot channel — one audit message per uploaded file part was
 *  flooding Telegram and delaying the parts themselves. */
function mirrorKv(owner: string, collection: string, key: string, value: unknown, op: 'SET' | 'DELETE'): void {
  try {
    if (collection === 'v5_blobmeta') return
    void import('./mirror').then(({ queueKvMirror, isV5MirrorActive }) => {
      if (!isV5MirrorActive()) return
      queueKvMirror({
        owner,
        collection,
        key,
        value,
        valueType: Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value,
        updatedAt: Date.now(),
        op,
      })
    })
  } catch {
    /* mirror optional */
  }
}

/** Fire-and-forget kv-delta upload (the FAST convergence channel — KBs,
 *  ~1-2s) after every regular KV write/delete. v5_blobmeta rides the blobs
 *  channel instead, so it does not trigger this. */
function queueDelta(collection: string): void {
  if (collection === 'v5_blobmeta') return
  try {
    void import('./backup').then(({ queueKvDeltaSnapshot }) => queueKvDeltaSnapshot())
  } catch {
    /* delta optional */
  }
}

/** v5_blobmeta deletes ride the blobs-snapshot metaDel list — record the key
 *  so the next blobs snapshot propagates the delete cross-instance fast. */
function noteMetaDelete(owner: string, collection: string, key: string): void {
  if (collection !== 'v5_blobmeta') return
  try {
    void import('./backup').then(({ noteBlobMetaDelete }) => noteBlobMetaDelete(owner, key))
  } catch {
    /* best-effort */
  }
}

// Register the collection sweep used by BATCH_SET invalidation (no import cycle).
registerCacheSweep((owner, collection) => {
  const prefix = `${owner}\u0000${collection}\u0000`
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k)
  }
})

export interface KvRow {
  key: string
  collection: string
  value: unknown
  updatedAt: number
}

interface CacheEntry {
  row: KvRow | null
  expires: number
}

const CACHE_TTL_MS = 30_000
const globalForCache = globalThis as unknown as { __v5KvCache?: Map<string, CacheEntry> }
const cache: Map<string, CacheEntry> = (globalForCache.__v5KvCache ??= new Map())

function ck(owner: string, collection: string, key: string): string {
  return `${owner}\u0000${collection}\u0000${key}`
}

/** Event-driven invalidation (called by emitEvent for KV_* types). */
export function invalidateKey(owner: string, collection: string, key: string): void {
  cache.delete(ck(owner, collection, key))
}

/** Drop the whole hot cache — called after snapshot restores write straight
 *  to SQLite, so reads never serve a pre-restore row or cached negative. */
export function clearKvCache(): void {
  cache.clear()
}

function rowToKv(row: Record<string, unknown>, collection: string, key: string): KvRow {
  let value: unknown = null
  try {
    value = JSON.parse(String(row.value))
  } catch {
    value = String(row.value)
  }
  return { key, collection, value, updatedAt: num(row.updated_at) }
}

export async function kvGet(owner: string, key: string, collection = 'default'): Promise<KvRow | null> {
  const k = ck(owner, collection, key)
  const hit = cache.get(k)
  if (hit && hit.expires > Date.now()) return hit.row
  const db = await v5db()
  const lookup = async () =>
    (
      await db.execute({
        sql: `SELECT value, updated_at FROM v5_kv WHERE owner = ? AND collection = ? AND key = ? AND deleted_at IS NULL LIMIT 1`,
        args: [owner, collection, key],
      })
    ).rows
  let rows = await lookup()
  if (rows.length === 0) {
    // Cross-instance freshness (file mode): the key may live on an instance
    // that booted after this one wrote it. One rate-limited probe + retry
    // before caching a negative result.
    try {
      const { ensureFreshness } = await import('./sync')
      await ensureFreshness()
      rows = await lookup()
    } catch {
      /* best-effort */
    }
  }
  const row = rows.length > 0 ? rowToKv(rows[0] as Record<string, unknown>, collection, key) : null
  cache.set(k, { row, expires: Date.now() + CACHE_TTL_MS })
  return row
}

function assertValueSize(json: string): void {
  if (Buffer.byteLength(json, 'utf8') > MAX_VALUE_BYTES) {
    throw Object.assign(new Error('Value exceeds the 256 KB KV limit — use the blob API for large payloads.'), {
      code: 'PAYLOAD_TOO_LARGE',
    })
  }
}

export async function kvSet(
  owner: string,
  key: string,
  value: unknown,
  collection = 'default'
): Promise<KvRow> {
  const json = JSON.stringify(value ?? null)
  assertValueSize(json)
  const now = nowMs()
  const db = await v5db()
  // Atomic: upsert + counter maintenance in one write batch.
  await db.batch(
    [
      {
        sql: `INSERT INTO v5_kv (owner, collection, key, value, size, created_at, updated_at, deleted_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
              ON CONFLICT(owner, collection, key) DO UPDATE SET
                value = excluded.value, size = excluded.size, updated_at = excluded.updated_at, deleted_at = NULL`,
        args: [owner, collection, key, json, Buffer.byteLength(json, 'utf8'), now, now],
      },
      {
        sql: `INSERT INTO v5_counters (owner, name, value, updated_at)
              VALUES (?, ?, 1, ?)
              ON CONFLICT(owner, name) DO UPDATE SET value = value + 1, updated_at = excluded.updated_at`,
        args: [owner, `kv:${collection}:live`, now],
      },
    ],
    'write'
  )
  const row: KvRow = { key, collection, value, updatedAt: now }
  cache.set(ck(owner, collection, key), { row, expires: Date.now() + CACHE_TTL_MS })
  void emitEvent(owner, 'KV_SET', `${collection}/${key}`, { key, collection })
  mirrorKv(owner, collection, key, value, 'SET')
  queueDelta(collection)
  return row
}

export async function kvSetBatch(
  owner: string,
  items: Array<{ key: string; value: unknown }>,
  collection = 'default'
): Promise<number> {
  if (items.length === 0) return 0
  if (items.length > 500) {
    throw Object.assign(new Error('Batch limited to 500 items.'), { code: 'VALIDATION_ERROR' })
  }
  const now = nowMs()
  const db = await v5db()
  const stmts = items.map((item) => {
    const json = JSON.stringify(item.value ?? null)
    assertValueSize(json)
    return {
      sql: `INSERT INTO v5_kv (owner, collection, key, value, size, created_at, updated_at, deleted_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
            ON CONFLICT(owner, collection, key) DO UPDATE SET
              value = excluded.value, size = excluded.size, updated_at = excluded.updated_at, deleted_at = NULL`,
      args: [owner, collection, item.key, json, Buffer.byteLength(json, 'utf8'), now, now],
    }
  })
  stmts.push({
    sql: `INSERT INTO v5_counters (owner, name, value, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(owner, name) DO UPDATE SET value = value + ?, updated_at = excluded.updated_at`,
    args: [owner, `kv:${collection}:live`, items.length, now, items.length],
  })
  await db.batch(stmts, 'write')
  for (const item of items) {
    cache.set(ck(owner, collection, item.key), {
      row: { key: item.key, collection, value: item.value, updatedAt: now },
      expires: Date.now() + CACHE_TTL_MS,
    })
  }
  void emitEvent(owner, 'BATCH_SET', `${collection}/*`, { count: items.length, collection })
  queueDelta(collection)
  return items.length
}

export async function kvDelete(owner: string, key: string, collection = 'default'): Promise<boolean> {
  const now = nowMs()
  const db = await v5db()
  const rs = await db.execute({
    sql: `UPDATE v5_kv SET deleted_at = ?, updated_at = ? WHERE owner = ? AND collection = ? AND key = ? AND deleted_at IS NULL`,
    args: [now, now, owner, collection, key],
  })
  const wasLive = rs.rowsAffected > 0
  if (wasLive) {
    await db.execute({
      sql: `INSERT INTO v5_counters (owner, name, value, updated_at)
            VALUES (?, ?, -1, ?)
            ON CONFLICT(owner, name) DO UPDATE SET value = MAX(0, value - 1), updated_at = excluded.updated_at`,
      args: [owner, `kv:${collection}:live`, now],
    })
  }
  cache.set(ck(owner, collection, key), { row: null, expires: Date.now() + CACHE_TTL_MS })
  void emitEvent(owner, 'KV_DELETED', `${collection}/${key}`, { key, collection })
  mirrorKv(owner, collection, key, null, 'DELETE')
  noteMetaDelete(owner, collection, key)
  queueDelta(collection)
  return wasLive
}

export interface KvPage {
  items: Array<{ key: string; value: unknown; updatedAt: number }>
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

export async function kvPage(
  owner: string,
  opts: { collection?: string; prefix?: string; limit?: number; offset?: number }
): Promise<KvPage> {
  const collection = opts.collection || 'default'
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000)
  const offset = Math.max(0, opts.offset ?? 0)
  const prefix = opts.prefix || ''
  const db = await v5db()
  const like = `${prefix.replace(/[%_\\]/g, (m) => '\\' + m)}%`
  const where = `owner = ? AND collection = ? AND deleted_at IS NULL AND key LIKE ? ESCAPE '\\'`
  const countRs = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM v5_kv WHERE ${where}`,
    args: [owner, collection, like],
  })
  const total = num((countRs.rows[0] as Record<string, unknown>)?.n)
  const rs = await db.execute({
    sql: `SELECT key, value, updated_at FROM v5_kv WHERE ${where} ORDER BY key LIMIT ? OFFSET ?`,
    args: [owner, collection, like, limit, offset],
  })
  const items = rs.rows.map((r) => {
    const row = r as Record<string, unknown>
    let value: unknown = null
    try {
      value = JSON.parse(String(row.value))
    } catch {
      value = String(row.value)
    }
    return { key: String(row.key), value, updatedAt: num(row.updated_at) }
  })
  return { items, total, limit, offset, hasMore: offset + items.length < total }
}

export async function kvCollections(owner: string): Promise<Array<{ collection: string; live: number }>> {
  const db = await v5db()
  const rs = await db.execute({
    sql: `SELECT collection, COUNT(*) AS n FROM v5_kv WHERE owner = ? AND deleted_at IS NULL GROUP BY collection ORDER BY collection`,
    args: [owner],
  })
  return rs.rows.map((r) => {
    const row = r as Record<string, unknown>
    return { collection: String(row.collection), live: num(row.n) }
  })
}

export async function kvStats(owner: string): Promise<Record<string, number>> {
  const db = await v5db()
  const rs = await db.execute({
    sql: `SELECT name, value FROM v5_counters WHERE owner = ?`,
    args: [owner],
  })
  const out: Record<string, number> = {}
  for (const r of rs.rows) {
    const row = r as Record<string, unknown>
    out[String(row.name)] = num(row.value)
  }
  return out
}

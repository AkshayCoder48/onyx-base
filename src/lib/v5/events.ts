/**
 * OnyxBase V5 — events (docs/v5-contract.md §17-18).
 *
 * Append-only event log + in-process emitter powering SSE pushes and
 * cache invalidation. Payloads are tiny metadata only.
 */

import { EventEmitter } from 'node:events'
import { v5db, nowMs, num } from './db'
import { invalidateKey } from './kv'

const globalForBus = globalThis as unknown as { __v5Bus?: EventEmitter }
const bus: EventEmitter = (globalForBus.__v5Bus ??= new EventEmitter().setMaxListeners(200))

// Registered BEFORE any function that may run during circular module init
// (kv.ts calls registerCacheSweep at its top level; events.ts imports
// invalidateKey from kv.ts — the cycle means this const must be initialized
// first or the TDZ bites).
function sweepRegistry(): Map<string, unknown> {
  const g = globalThis as unknown as { __v5KvPrefixCache?: Map<string, unknown> }
  return (g.__v5KvPrefixCache ??= new Map<string, unknown>())
}

export interface V5Event {
  id: number
  type: string
  subject: string | null
  payload: unknown
  createdAt: number
}

/** Append an event + fan out in-process (SSE listeners, cache invalidation). */
export async function emitEvent(owner: string, type: string, subject: string, payload: unknown): Promise<V5Event> {
  const now = nowMs()
  const db = await v5db()
  const rs = await db.execute({
    sql: `INSERT INTO v5_events (owner, type, subject, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
    args: [owner, type, subject, JSON.stringify(payload ?? null), now],
  })
  const id = Number(rs.lastInsertRowid)
  const evt: V5Event = { id, type, subject, payload, createdAt: now }
  // Cache invalidation — event-driven, surgical (never a full flush).
  if (type === 'KV_SET' || type === 'KV_DELETED' || type === 'BATCH_SET') {
    if (type === 'BATCH_SET') {
      // Batch: clear the whole collection namespace of the cache for breadth
      // (bounded: cache is key-addressed; drop matching prefixes).
      invalidateCollection(owner, subject.split('/')[0])
    } else {
      const [collection, key] = splitSubject(subject)
      if (key !== undefined) invalidateKey(owner, collection, key)
    }
  }
  bus.emit(`owner:${owner}`, evt)
  return evt
}

function splitSubject(subject: string): [string, string | undefined] {
  const i = subject.indexOf('/')
  if (i === -1) return [subject, undefined]
  return [subject.slice(0, i), subject.slice(i + 1)]
}

function invalidateCollection(owner: string, collection: string): void {
  // The kv cache lives in kv.ts's module scope; expose a sweep via a
  // registered callback to avoid import cycles.
  const fn = sweepRegistry().get('invalidateCollection') as ((o: string, c: string) => void) | undefined
  if (fn) fn(owner, collection)
}

/** kv.ts registers its collection-sweep here (avoids circular imports). */
export function registerCacheSweep(fn: (owner: string, collection: string) => void): void {
  sweepRegistry().set('invalidateCollection', fn)
}

export function subscribe(owner: string, listener: (evt: V5Event) => void): () => void {
  const ch = `owner:${owner}`
  bus.on(ch, listener)
  return () => bus.off(ch, listener)
}

export async function queryEvents(
  owner: string,
  opts: { since?: number; types?: string[]; limit?: number }
): Promise<{ events: V5Event[]; cursor: number }> {
  const since = Math.max(0, opts.since ?? 0)
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 500)
  const db = await v5db()
  const types = (opts.types || []).filter((t) => /^[A-Z_]{2,32}$/.test(t))
  let rs
  if (types.length > 0) {
    const placeholders = types.map(() => '?').join(',')
    rs = await db.execute({
      sql: `SELECT id, type, subject, payload, created_at FROM v5_events
            WHERE owner = ? AND id > ? AND type IN (${placeholders}) ORDER BY id ASC LIMIT ?`,
      args: [owner, since, ...types, limit],
    })
  } else {
    rs = await db.execute({
      sql: `SELECT id, type, subject, payload, created_at FROM v5_events
            WHERE owner = ? AND id > ? ORDER BY id ASC LIMIT ?`,
      args: [owner, since, limit],
    })
  }
  const events = rs.rows.map((r) => {
    const row = r as Record<string, unknown>
    let payload: unknown = null
    try {
      payload = JSON.parse(String(row.payload))
    } catch {
      payload = null
    }
    return {
      id: num(row.id),
      type: String(row.type),
      subject: (row.subject as string) ?? null,
      payload,
      createdAt: num(row.created_at),
    }
  })
  const cursor = events.length > 0 ? events[events.length - 1].id : since
  return { events, cursor }
}

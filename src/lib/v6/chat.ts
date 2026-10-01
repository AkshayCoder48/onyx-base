/**
 * Onyx Base — V6 Ultima chat engine.
 *
 * THE PROBLEM WITH V4: every durable write re-uploaded the account's ENTIRE
 * manifest document (gzip + sendDocument + pin + verify). On a 100k-key
 * collection that is a multi-MB upload per SET, seconds of latency, and a
 * hard wall at the cloud Bot API's 50MB upload / 20MB download caps — plus
 * cooperative pacing windows (12s global / 15s per-account) that throttled
 * the whole platform to ~one write per 12 seconds.
 *
 * V6 ULTIMA restructures the Telegram chat as an immutable sharded base +
 * a tiny per-write delta:
 *
 *   base    records sharded across IMMUTABLE gzipped chunk documents
 *           (10k-record accounts: 2 chunks; 100k-record accounts: ~13).
 *           Rewritten ONLY by compaction (background or rare inline).
 *
 *   delta   ONE small document per account: the "core" (user, apiKeys,
 *           logs, files metadata, share tokens, collection names, telegram
 *           configs, tombstones — always small) + the record ops since the
 *           last compaction. A durable write uploads ONLY this document,
 *           then edits the pinned index pointer. ~4 small Bot API calls.
 *           A SET on a 100k-key collection costs the same as a SET on an
 *           empty account: sub-second.
 *
 *   index   the pinned message (V6 marker) maps userId → entry. When the
 *           serialized index would pass Telegram's 4096-char pin cap (the
 *           production V4 pin was already at 3977/4096!), it flips to ref
 *           mode: a constant-size pointer pin + a gzipped index document.
 *
 * Restores fetch every chunk + the delta in PARALLEL (bounded width), so a
 * cold rehydrate of 100k keys is ~13 parallel small downloads — around one
 * second — instead of one giant document. Warm-instance freshness checks
 * download ONLY the delta (KBs) when the base rev is unchanged.
 *
 * CORRECTNESS (multi-instance): base chunks are immutable; the delta is the
 * only mutable doc and every writer MERGES the current durable delta into
 * its own before uploading (merge-first invariant). A lost index-edit race
 * is caught by the verify step (re-fetch: our entry's rev must be ≥ ours)
 * and by the post-verify repair, which re-runs the sync from memory — the
 * pending-op log keeps this instance's unconfirmed writes until a verified
 * tip (messageId ≥ ours) proves them durable. Tombstones make deletes stick
 * exactly as in V4.
 *
 * This module is deliberately FREE of data-store imports (the store imports
 * IT for sync routing) — store access flows through the adapter registered
 * by data-store at init. Record types are imported TYPE-ONLY (erased).
 */

import { createHash } from 'node:crypto'
import {
  fetchAccountIndex,
  fetchAccountIndexAllowEmpty,
  fetchAccountManifest,
  pinAccountIndex,
  sendGzippedJsonDocument,
  deleteTelegramMessage,
  downloadJsonDocument,
  isV6Entry,
  throttleYieldMs,
  type AccountEntryV6,
  type AccountIndex,
  type AccountManifest,
  type V6ChunkRef,
} from '@/lib/telegram'
import { mergeAccountManifests, msOf, asArray } from '@/lib/v6/merge'
import type { RecordEntry } from '@/lib/data-store'

// ─── Adapter (registered by data-store at init — no import cycle) ───────────

export interface V6StoreAdapter {
  /** Tombstone TTL (ms) — owned by data-store. */
  tombstoneTtlMs: number
  /** Full manifest for the account with records: [] (the "core"). */
  buildCoreManifest(userId: string): AccountManifest | null
  /** Full manifest incl. records, from local memory. */
  buildFullManifest(userId: string): AccountManifest | null
  /** This account's records currently in local memory. */
  localRecords(userId: string): RecordEntry[]
  /** Fold a manifest into local memory (merge semantics). */
  restoreManifest(m: AccountManifest): { users: number; apiKeys: number; records: number; logs: number; files: number }
  /** The rev (messageId) this instance last confirmed durable, if any. */
  lastDurableRev(userId: string): number | undefined
  /** Record a confirmed-durable rev for the account. */
  noteDurable(userId: string, entry: AccountEntryV6): void
  /** Serverless freeze guard for background work (compaction / repair). */
  keepAlive(fn: () => Promise<unknown>): void
}

let adapter: V6StoreAdapter | null = null

export function registerV6StoreAdapter(a: V6StoreAdapter): void {
  adapter = a
}

// ─── Chat-format constants ───────────────────────────────────────────────────

const CHUNK_MARKER = 'CLOUDKV_V6_CHUNK'
const DELTA_MARKER = 'CLOUDKV_V6_DELTA'

/** Records per chunk target (~20k — fewer docs = fewer round trips on
 * restore; 100k keys ≈ 5 chunks, fetched in ONE parallel wave). */
const V6_CHUNK_TARGET_RECORDS = 20000
/** Raw JSON bytes per chunk ceiling (~20MB raw ⇒ ~2-5MB gz, far under caps). */
const V6_CHUNK_TARGET_RAW_BYTES = 20 * 1024 * 1024
/**
 * Ops in the delta above which the sync compacts INLINE (rare huge bursts).
 * Sized so a full 5000-record import batch (the route's per-request cap)
 * rides the fast delta path — compaction then runs in the background
 * between batches instead of taxing every import request.
 */
const V6_MAX_DELTA_OPS = 20000
/** Raw delta JSON above which the sync compacts INLINE. */
const V6_MAX_DELTA_RAW_BYTES = 3.5 * 1024 * 1024
/** Post-sync BACKGROUND compaction triggers (keep deltas sub-second). */
const V6_COMPACT_OPS = 8000
const V6_COMPACT_RAW_BYTES = 2 * 1024 * 1024
/** Parallel download width for restores (Telegram's lenient bucket). */
const DOWNLOAD_CONCURRENCY = 6
/** Parallel upload width for compaction (bursts tolerated, bounded). */
const UPLOAD_CONCURRENCY = 3

// ─── Delta doc shapes ────────────────────────────────────────────────────────

export interface V6DeltaOp {
  op: 'set' | 'del'
  collection: string
  key: string
  /** ISO ts of the mutation (last-write-wins ordering). */
  ts: string
  /** Owner dbUserId — REQUIRED on set ops: rehydrating instances build new
   * records from ops alone, and restoreAccountManifest drops records
   * without a userId (a missing owner silently lost delta-applied records
   * on every cold rehydrate). */
  userId?: string
  /** Serialized value (set only). */
  value?: string
  valueType?: string
  valueRef?: { fileId: string; messageId: number; bytes: number } | null
  id?: string
  createdAt?: string
}

interface V6ChunkDoc {
  cloudkv: true
  kind: 'account-chunk'
  version: 6
  userId: string
  shard: number
  compactedAt: string
  records: RecordEntry[]
}

interface V6DeltaDoc {
  cloudkv: true
  kind: 'account-delta'
  version: 6
  userId: string
  baseRev: number
  core: AccountManifest
  ops: V6DeltaOp[]
}

// ─── Module state ────────────────────────────────────────────────────────────

/**
 * Pending (not-yet-confirmed-durable) record ops per account, keyed by
 * `collection|key` (latest op per key wins). Cleared for ops subsumed by a
 * verified tip. Survives sync failures so retries re-include them.
 */
const pendingOps = new Map<string, Map<string, V6DeltaOp>>()

/** The delta fileId this instance last consumed (ours or a rival's). */
const lastDeltaFileId = new Map<string, string>()

/** Content sha of the delta this instance last confirmed pinned. */
const lastDeltaContentSha = new Map<string, string>()

/** Base rev this instance has fully hydrated into memory (chunks or own compaction). */
const hydratedBaseRev = new Map<string, number>()

/** Immutable-document cache (chunks, deltas) keyed by fileId. */
interface CachedDoc {
  json: unknown
  at: number
}
const docCache = new Map<string, CachedDoc>()
const DOC_CACHE_TTL_MS = 10 * 60_000
const DOC_CACHE_MAX = 48

/** Single-flight background compaction per account. */
const compactionInFlight = new Map<string, Promise<unknown>>()

const stats = {
  deltaSyncs: 0,
  compactions: 0,
  migrations: 0,
  rehydrates: 0,
  deltaOnlyRehydrates: 0,
  lastError: null as string | null,
}

export function v6ChatStats() {
  let pendingAccounts = 0
  let pendingOpCount = 0
  for (const m of pendingOps.values()) {
    if (m.size > 0) {
      pendingAccounts++
      pendingOpCount += m.size
    }
  }
  return { ...stats, pendingAccounts, pendingOpCount }
}

function noteError(scope: string, err: unknown): void {
  stats.lastError = `${scope}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200)
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(() => r(), ms))

/** Worker-pool map with bounded concurrency. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

function docCacheGet<T>(fileId: string): T | null {
  const hit = docCache.get(fileId)
  if (!hit) return null
  if (Date.now() - hit.at > DOC_CACHE_TTL_MS) {
    docCache.delete(fileId)
    return null
  }
  return hit.json as T
}

function docCacheSet(fileId: string, json: unknown): void {
  if (docCache.size >= DOC_CACHE_MAX) {
    const oldest = docCache.keys().next()
    if (!oldest.done) docCache.delete(oldest.value)
  }
  docCache.set(fileId, { json, at: Date.now() })
}

/** Download + parse one immutable document (cached by fileId). */
async function fetchV6Doc<T>(fileId: string): Promise<T | null> {
  const hit = docCacheGet<T>(fileId)
  if (hit) return hit
  const text = await downloadJsonDocument(fileId)
  if (text === null) return null
  try {
    const json = JSON.parse(text) as T
    docCacheSet(fileId, json)
    return json
  } catch (err) {
    noteError('doc parse', err)
    return null
  }
}

// ─── Pending-op log (fed by data-store mutation hooks) ──────────────────────

/** Record a SET mutation (post-write record state) into the pending log. */
export function noteV6RecordSet(
  userId: string,
  rec: Pick<RecordEntry, 'collection' | 'key' | 'value' | 'valueType' | 'valueRef' | 'updatedAt' | 'createdAt' | 'id' | 'userId'>,
): void {
  let m = pendingOps.get(userId)
  if (!m) {
    m = new Map()
    pendingOps.set(userId, m)
  }
  m.set(`${rec.collection}|${rec.key}`, {
    op: 'set',
    collection: rec.collection,
    key: rec.key,
    ts: rec.updatedAt,
    userId: rec.userId,
    value: rec.value,
    valueType: rec.valueType,
    valueRef: rec.valueRef ?? null,
    id: rec.id,
    createdAt: rec.createdAt,
  })
}

/** Record a DELETE mutation into the pending log. */
export function noteV6RecordDelete(userId: string, collection: string, key: string): void {
  let m = pendingOps.get(userId)
  if (!m) {
    m = new Map()
    pendingOps.set(userId, m)
  }
  m.set(`${collection}|${key}`, {
    op: 'del',
    collection,
    key,
    ts: new Date().toISOString(),
  })
}

/** Drop pending ops with ts ≤ cutoff (they are inside a verified durable tip). */
function clearPendingUpTo(userId: string, cutoffIso: string): void {
  const m = pendingOps.get(userId)
  if (!m) return
  const cutoff = msOf(cutoffIso)
  for (const [k, op] of m) {
    if (msOf(op.ts) <= cutoff) m.delete(k)
  }
  if (m.size === 0) pendingOps.delete(userId)
}

/** Union a set of ops into an account's pending log (latest-ts wins). */
function mergePendingOps(userId: string, ops: V6DeltaOp[]): void {
  if (ops.length === 0) return
  let m = pendingOps.get(userId)
  if (!m) {
    m = new Map()
    pendingOps.set(userId, m)
  }
  for (const op of mergeOps([...m.values()], ops)) {
    m.set(`${op.collection}|${op.key}`, op)
  }
}

/**
 * THE DURABILITY INVARIANT: a delta doc is the ONLY durable home for its
 * ops (the base chunks do not contain them). Any instance that CONSUMES a
 * delta (rival fetch, rehydrate, overflow merge) or PINS one must keep its
 * full op set in the pending log — the next delta this instance builds is
 * then a superset and never folds ops away. Cleared ONLY by a compaction
 * that folds the ops into the immutable base.
 */
function consumeDeltaDoc(userId: string, fileId: string, delta: V6DeltaDoc): void {
  lastDeltaFileId.set(userId, fileId)
  mergePendingOps(userId, asArray<V6DeltaOp>(delta.ops))
}

/** Union of remote + pending ops, latest-ts wins per `collection|key`. */
function mergeOps(remote: V6DeltaOp[], pending: V6DeltaOp[]): V6DeltaOp[] {
  const byKey = new Map<string, V6DeltaOp>()
  for (const op of remote) byKey.set(`${op.collection}|${op.key}`, op)
  for (const op of pending) {
    const prev = byKey.get(`${op.collection}|${op.key}`)
    if (!prev || msOf(op.ts) >= msOf(prev.ts)) byKey.set(`${op.collection}|${op.key}`, op)
  }
  return [...byKey.values()].sort((a, b) => msOf(a.ts) - msOf(b.ts))
}

/** Apply delta ops onto a record set (conditional, last-write-wins). */
function applyDeltaOps(records: RecordEntry[], ops: V6DeltaOp[]): RecordEntry[] {
  if (ops.length === 0) return records
  const byIdentity = new Map<string, RecordEntry>()
  for (const r of records) byIdentity.set(`${r.collection}|${r.key}`, r)
  for (const op of ops) {
    const k = `${op.collection}|${op.key}`
    const existing = byIdentity.get(k)
    if (op.op === 'set') {
      if (!existing || msOf(op.ts) > msOf(existing.updatedAt)) {
        byIdentity.set(k, {
          id: op.id || existing?.id || '',
          // Owner: the op's own userId (present on all ops written after the
          // fix), else the existing record's — NEVER '' (records without an
          // owner are dropped by restoreAccountManifest).
          userId: op.userId ?? existing?.userId ?? '',
          collection: op.collection,
          key: op.key,
          value: op.value ?? '',
          valueType: op.valueType ?? 'string',
          telegramMessageId: existing?.telegramMessageId ?? null,
          valueRef: op.valueRef ?? null,
          createdAt: op.createdAt ?? existing?.createdAt ?? op.ts,
          updatedAt: op.ts,
        })
      }
    } else if (existing && msOf(op.ts) > msOf(existing.updatedAt)) {
      byIdentity.delete(k)
    }
  }
  return [...byIdentity.values()]
}

/**
 * Canonical delta content sha: core (minus volatile exportedAt + append-only
 * logs, exactly like manifestContentSha) + ops. Two builds of unchanged
 * state hash identically → the sync short-circuits instead of re-pinning.
 */
function deltaContentSha(core: AccountManifest, ops: V6DeltaOp[]): string {
  const { exportedAt: _e, logs: _l, ...coreRest } = core as AccountManifest & {
    exportedAt?: unknown
    logs?: unknown
  }
  void _e
  void _l
  return createHash('sha256')
    .update(JSON.stringify({ core: coreRest, ops }), 'utf8')
    .digest('hex')
}

// ─── Sharding ────────────────────────────────────────────────────────────────

/** Deterministic order (collection, then key) — stable chunks across compactions. */
function sortRecords(records: RecordEntry[]): RecordEntry[] {
  return [...records].sort((a, b) =>
    a.collection === b.collection ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.collection < b.collection ? -1 : 1,
  )
}

/** Split records into chunks by count + raw-size ceilings. */
function shardRecords(records: RecordEntry[]): RecordEntry[][] {
  const sorted = sortRecords(records)
  const shards: RecordEntry[][] = []
  let cur: RecordEntry[] = []
  let curBytes = 0
  for (const r of sorted) {
    const sz = r.value.length + r.key.length + r.collection.length + 96
    if (cur.length > 0 && (cur.length >= V6_CHUNK_TARGET_RECORDS || curBytes + sz > V6_CHUNK_TARGET_RAW_BYTES)) {
      shards.push(cur)
      cur = []
      curBytes = 0
    }
    cur.push(r)
    curBytes += sz
  }
  if (cur.length > 0) shards.push(cur)
  return shards
}

// ─── Compaction (immutable base rewrite) ─────────────────────────────────────

/**
 * Build + upload a fresh chunked base + a core-only delta for the account,
 * then pin the index. `merged` MUST already be the converged state (local
 * memory ∪ durable). Returns the pinned entry, or null on failure (partial
 * uploads are harmless orphans in chat history — never referenced).
 */
async function compactAndPin(
  userId: string,
  idx: AccountIndex,
  merged: AccountManifest,
  nextBaseRev: number,
): Promise<AccountEntryV6 | null> {
  const now = new Date().toISOString()
  const shards = shardRecords(asArray<RecordEntry>(merged.records))

  // Upload chunks with bounded parallelism.
  const chunkDocs = shards.map((records, i) => ({ records, i }))
  const uploaded = await mapWithConcurrency(chunkDocs, UPLOAD_CONCURRENCY, async ({ records, i }) => {
    const doc: V6ChunkDoc = {
      cloudkv: true,
      kind: 'account-chunk',
      version: 6,
      userId,
      shard: i,
      compactedAt: now,
      records,
    }
    const sent = await sendGzippedJsonDocument(
      JSON.stringify(doc),
      `onyxbase-v6-${userId}-c${i}.json.gz`,
      CHUNK_MARKER,
    )
    return sent ? { sent, doc, i } : null
  })
  if (uploaded.some((u) => u === null)) return null

  // Core-only delta (ops reset — everything is folded into the base).
  const core: AccountManifest = { ...merged, records: [] }
  const deltaDoc: V6DeltaDoc = {
    cloudkv: true,
    kind: 'account-delta',
    version: 6,
    userId,
    baseRev: nextBaseRev,
    core,
    ops: [],
  }
  const deltaSent = await sendGzippedJsonDocument(
    JSON.stringify(deltaDoc),
    `onyxbase-v6-${userId}-delta.json.gz`,
    DELTA_MARKER,
  )
  if (!deltaSent) return null

  const chunks: V6ChunkRef[] = uploaded.map((u) => ({
    fileId: u!.sent.fileId,
    messageId: u!.sent.messageId,
    shard: u!.i,
    count: u!.doc.records.length,
    bytes: u!.sent.bytes,
  }))
  const baseBytes = chunks.reduce((s, c) => s + c.bytes, 0)
  const entry: AccountEntryV6 = {
    userId,
    format: 6,
    messageId: Math.max(deltaSent.messageId, ...chunks.map((c) => c.messageId)),
    fileId: deltaSent.fileId,
    bytes: baseBytes + deltaSent.bytes,
    recordCount: asArray<RecordEntry>(merged.records).length,
    updatedAt: now,
    base: { rev: nextBaseRev, compactedAt: now, chunks },
    delta: { messageId: deltaSent.messageId, fileId: deltaSent.fileId, ops: 0, bytes: deltaSent.bytes },
  }
  const idx2: AccountIndex = {
    ...idx,
    version: 6,
    accounts: { ...idx.accounts, [userId]: entry },
    exportedAt: now,
  }
  const pinned = await pinAccountIndex(idx2)
  if (!pinned) return null

  // Verify our entry is the tip (or subsumed by a later writer).
  const verify = await fetchAccountIndex()
  const cur = verify?.accounts[userId]
  if (!verify || !cur || !isV6Entry(cur) || cur.messageId < entry.messageId) return null

  // Success: this instance's memory IS the new base — cache the docs so
  // imminent reads/syncs don't re-download them, and mark the base hydrated.
  for (const u of uploaded) docCacheSet(u!.sent.fileId, u!.doc)
  docCacheSet(deltaSent.fileId, deltaDoc)
  hydratedBaseRev.set(userId, entry.base.rev)
  lastDeltaFileId.set(userId, entry.delta!.fileId)
  lastDeltaContentSha.set(userId, deltaContentSha(core, []))
  stats.compactions++
  adapter?.noteDurable(userId, cur)

  // Best-effort cleanup of superseded docs (AFTER the new pin landed).
  const prev = idx.accounts[userId]
  if (prev && isV6Entry(prev)) {
    for (const c of prev.base.chunks) void deleteTelegramMessage(c.messageId).catch(() => {})
    if (prev.delta) void deleteTelegramMessage(prev.delta.messageId).catch(() => {})
  }
  return cur
}

/** Sync single-flight guard (both detached + after() paths share it). */
const compactionRunning = new Set<string>()

/** The actual compaction run — single-flighted across ALL trigger paths. */
async function runCompactionOnce(userId: string): Promise<boolean> {
  const a = adapter
  if (!a) return false
  if (compactionRunning.has(userId)) return false
  compactionRunning.add(userId)
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (throttleYieldMs() > 0) return true
      const idx = await fetchAccountIndex()
      if (!idx) continue
      const entry = idx.accounts[userId]
      if (!entry || !isV6Entry(entry)) return true
      const local = a.buildFullManifest(userId)
      if (!local) return true
      // Converge: durable state (chunks + delta) merged into local memory.
      const state = await fetchV6State(entry)
      if (!state) continue
      const merged = mergeAccountManifests(local, state.manifest, a.tombstoneTtlMs)
      a.restoreManifest(merged)
      const pinned = await compactAndPin(userId, idx, merged, entry.base.rev + 1)
      if (pinned) {
        clearPendingUpTo(userId, new Date().toISOString())
        return true
      }
    }
    return false
  } finally {
    compactionRunning.delete(userId)
  }
}

/**
 * Full background compaction: converge local memory with the durable state,
 * then rebuild the base. Triggered when a delta grows past the background
 * thresholds — never on the request path.
 *
 * Runs on BOTH rails (whichever is alive):
 *   - detached task: dev processes + warm serverless instances
 *   - after() keepAlive registered at TRIGGER time (inside the request):
 *     the callback must be registered BEFORE the response completes —
 *     registering it after a sleep meant serverless froze the instance and
 *     the compaction silently never ran (leaving fat deltas that taxed
 *     every later write).
 */
function compactV6AccountInBackground(userId: string): void {
  if (compactionInFlight.has(userId)) return
  const a = adapter
  if (!a) return
  // Rail 1: detached (fires ~2.5s later on any still-running instance).
  const task = (async () => {
    try {
      await sleep(2500) // let the triggering request finish first
      await runCompactionOnce(userId)
    } catch (err) {
      noteError('bg compaction', err)
    } finally {
      compactionInFlight.delete(userId)
    }
  })()
  compactionInFlight.set(userId, task)
  // Rail 2: serverless freeze guard (registered while still in-request).
  a.keepAlive(() => runCompactionOnce(userId))
}

// ─── Durable-state fetch (parallel chunks + delta) ───────────────────────────

interface V6State {
  manifest: AccountManifest
  baseRev: number
}

/**
 * Fetch an account's full durable state: all base chunks + the delta, in
 * PARALLEL, then apply the delta ops on top of the chunk records. Chunk and
 * delta documents are immutable per fileId, so repeated fetches hit the
 * doc cache — the delta-only refresh path costs one small download.
 */
async function fetchV6State(entry: AccountEntryV6): Promise<V6State | null> {
  const chunks = [...entry.base.chunks].sort((a, b) => a.shard - b.shard)
  const needsDelta = !!entry.delta
  const work: Promise<unknown>[] = []
  const chunkDocsP = mapWithConcurrency(chunks, DOWNLOAD_CONCURRENCY, (c) => fetchV6Doc<V6ChunkDoc>(c.fileId))
  work.push(chunkDocsP)
  const deltaP = needsDelta ? fetchV6Doc<V6DeltaDoc>(entry.delta!.fileId) : Promise.resolve(null)
  work.push(deltaP)
  const [chunkDocsRaw, deltaRaw] = (await Promise.all(work)) as [Array<V6ChunkDoc | null>, V6DeltaDoc | null]
  const chunkDocs = chunkDocsRaw.filter((d): d is V6ChunkDoc => d !== null)
  if (chunkDocs.length !== chunks.length) return null
  if (needsDelta && !deltaRaw) return null

  const baseRecords: RecordEntry[] = []
  for (const d of chunkDocs) baseRecords.push(...asArray<RecordEntry>(d.records))
  const delta = deltaRaw as V6DeltaDoc | null
  const records = delta ? applyDeltaOps(baseRecords, delta.ops) : baseRecords
  const core: AccountManifest = delta
    ? delta.core
    : {
        cloudkv: true,
        kind: 'account-manifest',
        version: 4,
        userId: entry.userId,
        exportedAt: entry.base.compactedAt,
        user: null,
        apiKeys: [],
        records: [],
        logs: [],
        files: [],
        shareTokens: [],
        collectionNames: [],
        telegramConfigs: [],
      }
  // Durability invariant: the delta's ops live ONLY in that doc — keep them
  // pending so any future delta we build is a superset (see consumeDeltaDoc).
  if (delta && entry.delta) consumeDeltaDoc(entry.userId, entry.delta.fileId, delta)
  return { manifest: { ...core, records }, baseRev: entry.base.rev }
}

// ─── Rehydrate (read path) ───────────────────────────────────────────────────

export interface V6RehydrateResult {
  attempted: boolean
  users: number
  apiKeys: number
  records: number
  logs: number
  files: number
  error?: string
}

/**
 * Restore one account from its V6 entry. Fast path: when this instance has
 * already hydrated the same base rev (memory holds the chunk records), only
 * the small delta doc is fetched and its ops applied on top of memory — a
 * freshness refresh costs one small download even for 100k-key accounts.
 */
export async function rehydrateV6Account(
  userId: string,
  entry: AccountEntryV6,
): Promise<V6RehydrateResult> {
  const a = adapter
  if (!a) return { attempted: false, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0 }
  stats.rehydrates++
  try {
    const baseKnown = hydratedBaseRev.get(userId) === entry.base.rev

    if (baseKnown) {
      // DELTA-ONLY refresh: memory already holds this exact base rev — one
      // small doc, KBs at any account size.
      if (!entry.delta) {
        // Compaction just reset the delta: nothing newer than our base.
        a.noteDurable(userId, entry)
        return { attempted: true, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0 }
      }
      const delta = await fetchV6Doc<V6DeltaDoc>(entry.delta.fileId)
      if (!delta) return { attempted: true, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0, error: 'delta download failed' }
      consumeDeltaDoc(userId, entry.delta.fileId, delta)
      stats.deltaOnlyRehydrates++
      const records = applyDeltaOps(a.localRecords(userId), delta.ops)
      const manifest: AccountManifest = { ...delta.core, records }
      const r = a.restoreManifest(manifest)
      a.noteDurable(userId, entry)
      lastDeltaContentSha.set(userId, deltaContentSha(delta.core, delta.ops))
      return { attempted: true, ...r }
    }

    // FULL path: chunks + delta fetched in ONE parallel wave (fetchV6State
    // fans both out across the download pool — no sequential delta round).
    const state = await fetchV6State(entry)
    if (!state) return { attempted: true, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0, error: 'chunk download failed' }
    hydratedBaseRev.set(userId, entry.base.rev)
    const delta = entry.delta ? await fetchV6Doc<V6DeltaDoc>(entry.delta.fileId) : null
    const r = a.restoreManifest(state.manifest)
    a.noteDurable(userId, entry)
    lastDeltaContentSha.set(
      userId,
      deltaContentSha(delta ? delta.core : state.manifest, delta ? delta.ops : []),
    )
    return { attempted: true, ...r }
  } catch (err) {
    noteError('rehydrate', err)
    return { attempted: true, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── Sync (write path) ───────────────────────────────────────────────────────

export interface V6SyncOpts {
  /** False when called from a repair — repairs must not schedule repairs. */
  scheduleRepair?: boolean
}

/**
 * Make an account's durable state include this instance's writes — the V6
 * Ultima fast path. Typical cost: ONE small delta upload + ONE index edit +
 * verification (~4 small Bot API calls, sub-second at any account size).
 * Compaction (immutable base rewrite) happens only when the delta grows
 * past the triggers — background after a verified sync, inline for rare
 * huge bursts (e.g. a 100k-record import rides the migration/compaction
 * path once, then writes are delta-fast again).
 */
export async function syncV6Account(
  userId: string,
  opts: V6SyncOpts = {},
): Promise<AccountEntryV6 | null> {
  const a = adapter
  if (!a) return null
  if (throttleYieldMs() > 0) return null

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(1200 + Math.random() * 800)

    // Allow-empty: a chat with NO pin yet is a fresh install — the
    // migration branch below pins the very first index. Null (unreadable /
    // foreign pin) still aborts the attempt (anti-clobber).
    const idx = await fetchAccountIndexAllowEmpty()
    if (!idx) continue

    const entry = idx.accounts[userId]

    // ── Migration: V4 entry (or brand-new account) → build the V6 base.
    if (!entry || !isV6Entry(entry)) {
      const local = a.buildFullManifest(userId)
      if (!local) return null
      let merged = local
      if (entry) {
        const v4 = await fetchAccountManifest(entry.fileId)
        if (!v4) continue // durable base unreadable — never clobber
        merged = mergeAccountManifests(local, v4, a.tombstoneTtlMs)
      }
      a.restoreManifest(merged)
      const pinned = await compactAndPin(userId, idx, merged, 1)
      if (pinned) {
        stats.migrations++
        clearPendingUpTo(userId, new Date().toISOString())
        return pinned
      }
      continue
    }

    // ── V6 fast path.
    const core = a.buildCoreManifest(userId)
    if (!core) return null

    const pendingSnapshotAt = new Date().toISOString()
    const pending = [...(pendingOps.get(userId)?.values() ?? [])]

    // Content short-circuit: nothing pending, tip is ours, core unchanged.
    if (
      pending.length === 0 &&
      entry.messageId === a.lastDurableRev(userId) &&
      lastDeltaContentSha.get(userId) === deltaContentSha(core, [])
    ) {
      return entry
    }

    // Rival delta: fetch + merge ONLY when the tip delta is one we haven't
    // already consumed (single-writer fast path skips this download).
    let remoteDelta: V6DeltaDoc | null = null
    if (entry.delta && entry.delta.fileId !== lastDeltaFileId.get(userId)) {
      remoteDelta = await fetchV6Doc<V6DeltaDoc>(entry.delta.fileId)
      if (!remoteDelta) continue // unreadable — fail the attempt, never clobber
      consumeDeltaDoc(userId, entry.delta.fileId, remoteDelta)
    }

    const mergedOps = mergeOps(remoteDelta?.ops ?? [], pending)
    const mergedCore = remoteDelta
      ? mergeAccountManifests(core, remoteDelta.core, a.tombstoneTtlMs)
      : core

    const deltaDoc: V6DeltaDoc = {
      cloudkv: true,
      kind: 'account-delta',
      version: 6,
      userId,
      baseRev: entry.base.rev,
      core: mergedCore,
      ops: mergedOps,
    }
    const deltaJson = JSON.stringify(deltaDoc)

    // Delta overflow → compaction. When a BACKGROUND compaction is already
    // running for this account (a prior batch's trigger), JOIN it (bounded
    // wait) instead of duplicating the whole re-shard on the request path —
    // after it lands, the retry takes the small-delta path again.
    if (mergedOps.length > V6_MAX_DELTA_OPS || deltaJson.length > V6_MAX_DELTA_RAW_BYTES) {
      const inflight = compactionInFlight.get(userId)
      if (inflight) {
        await Promise.race([inflight, sleep(10_000)])
        continue // fresh attempt: the index now points at the compacted base
      }
      const state = await fetchV6State(entry)
      if (state) {
        const localFull = a.buildFullManifest(userId)
        if (localFull) {
          const merged = mergeAccountManifests(localFull, state.manifest, a.tombstoneTtlMs)
          a.restoreManifest(merged)
          const pinned = await compactAndPin(userId, idx, merged, entry.base.rev + 1)
          if (pinned) {
            // Compaction folded EVERYTHING (local memory ∪ durable state)
            // into the new base — the pending log is fully subsumed.
            clearPendingUpTo(userId, new Date().toISOString())
            return pinned
          }
        }
      }
      continue
    }

    // Upload ONLY the small delta — this is the instant write.
    const sent = await sendGzippedJsonDocument(
      deltaJson,
      `onyxbase-v6-${userId}-delta.json.gz`,
      DELTA_MARKER,
    )
    if (!sent) continue

    const newEntry: AccountEntryV6 = {
      userId,
      format: 6,
      messageId: Math.max(entry.messageId, sent.messageId),
      fileId: sent.fileId,
      bytes:
        entry.base.chunks.reduce((s, c) => s + c.bytes, 0) +
        sent.bytes,
      recordCount: a.localRecords(userId).length,
      updatedAt: new Date().toISOString(),
      base: entry.base,
      delta: { messageId: sent.messageId, fileId: sent.fileId, ops: mergedOps.length, bytes: sent.bytes },
    }
    const idx2: AccountIndex = {
      ...idx,
      version: 6,
      accounts: { ...idx.accounts, [userId]: newEntry },
      exportedAt: new Date().toISOString(),
    }
    const pinned = await pinAccountIndex(idx2)
    if (!pinned) continue

    // Verify: our entry is the tip for this account, or a later writer
    // (who — by the merge-first invariant — built on top of our delta).
    const verify = await fetchAccountIndex()
    const cur = verify?.accounts[userId]
    if (verify && cur && isV6Entry(cur) && cur.messageId >= sent.messageId) {
      docCacheSet(sent.fileId, deltaDoc)
      hydratedBaseRev.set(userId, cur.base.rev)
      a.noteDurable(userId, cur)
      lastDeltaFileId.set(userId, cur.delta?.fileId ?? sent.fileId)
      lastDeltaContentSha.set(userId, deltaContentSha(mergedCore, mergedOps))
      // DURABILITY INVARIANT: do NOT clear the pending ops — the delta we
      // just pinned is their only durable home (the base has no chunks for
      // them). Keep the FULL merged set pending so our next delta subsumes
      // this one. A compaction folds them into the base and clears them.
      mergePendingOps(userId, mergedOps)
      stats.deltaSyncs++
      // Delta grown big → compact in the background (off the request path).
      if ((cur.delta?.ops ?? 0) >= V6_COMPACT_OPS || (cur.delta?.bytes ?? 0) >= V6_COMPACT_RAW_BYTES) {
        compactV6AccountInBackground(userId)
      }
      // Rival may have overwritten our index edit right after our verify
      // fetch — the post-verify check re-syncs from memory if we were
      // silently reverted (pending ops are the source of truth for
      // everything not yet folded into a base).
      if (opts.scheduleRepair !== false) a.keepAlive(() => postVerifyCheck(userId, cur.messageId))
      return cur
    }
    // Lost the pin race — retry with a fresh fetch-merge.
  }
  return null
}

/**
 * Post-verify convergence check (background): a rival instance can pin
 * between our fetch and our edit, silently reverting our entry. Seconds
 * later we re-check the tip: if our rev is gone, re-run the sync from
 * memory (the pending-op log still holds anything not confirmed durable).
 */
async function postVerifyCheck(userId: string, expectedRev: number): Promise<boolean> {
  try {
    await sleep(6000)
    for (let round = 0; round < 3; round++) {
      if (throttleYieldMs() > 0) return true // flood — the breaker owns the wait
      const idx = await fetchAccountIndex()
      const cur = idx?.accounts[userId]
      if (idx && cur && isV6Entry(cur) && cur.messageId >= expectedRev) return true
      const re = await syncV6Account(userId, { scheduleRepair: false })
      if (re) return true
      await sleep(8000)
    }
    return false
  } catch (err) {
    noteError('postVerify', err)
    return false
  }
}

/** Test/observability hook: is a background compaction running? */
export function v6CompactionInFlight(userId: string): boolean {
  return compactionInFlight.has(userId)
}

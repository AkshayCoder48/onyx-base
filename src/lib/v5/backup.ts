/**
 * OnyxBase V5 — Telegram full-state snapshot backup + restore.
 *
 * Telegram's role inside V5 (the "data saver"):
 *
 *   1. Per-write audit messages  — mirror.ts, fire-and-forget, V4 message format.
 *   2. FULL SNAPSHOTS            — the entire v5_kv table + blob metadata +
 *                                  staged-blob part references, gzipped and
 *                                  uploaded as ONE Telegram document.
 *   3. RESTORE                   — rebuild the SQLite store from the latest
 *                                  snapshot: pinned account index →
 *                                  `__v5_snapshot__` entry → download → gunzip →
 *                                  bulk upsert.
 *
 * The snapshot registers itself in the SAME pinned V4 account index the V4
 * layer maintains (userId `__v5_snapshot__`), so V4 and V5 share ONE pinned
 * message — no pin contention, and a V4 rollback keeps working.
 *
 * Snapshots are uploaded from the background mirror drain (never the request
 * path), after migrations, and on demand via POST /api/v5/admin/backup.
 * Cold boots with an EMPTY database auto-restore from the latest snapshot
 * (file mode always; remote mode only with V5_AUTO_RESTORE=true).
 */

import { gunzipSync, gzipSync, createGzip } from 'node:zlib'
import fs from 'fs'
import path from 'path'
import {
  fetchAccountIndex,
  getFileDownloadUrl,
  isTelegramConfigured,
  pinAccountIndex,
  sendDocumentFile,
  type AccountIndex,
} from '@/lib/telegram'
import { isFileMode, isV5TelegramBackupEnabled, v5db } from './db'
import { clearKvCache } from './kv'
import { durable } from './durable'

/** Pinned-index userId under which the V5 snapshot document is registered. */
export const V5_SNAPSHOT_ACCOUNT = '__v5s__'

/** Bot-bio marker for the fallback snapshot pointer (setMyDescription). */
const BIO_MARKER = 'ONYXBASE_V5_SNAPSHOT'

/** Upload a fresh snapshot after this many mirrored writes (queue idle). */
const SNAPSHOT_EVERY_WRITES = 10

/** Minimum spacing between idle-cadence snapshots (convergence vs API load). */
const SNAPSHOT_MIN_INTERVAL_MS = 15_000

/** Minimum spacing between auth-triggered snapshots (per instance). */
const AUTH_SNAPSHOT_MIN_INTERVAL_MS = 5_000

const CAPTION_MARKER = 'ONYXBASE_V5_SNAPSHOT'

interface KvSnapRow {
  o: string
  c: string
  k: string
  v: string
  s: number
  ca: number
  ua: number
  d: number | null
}

interface BlobSnapRow {
  id: string
  owner: string
  filename: string | null
  mime: string | null
  size: number
  checksum: string | null
  status: string
  storage_key: string | null
  chunks: number
  is_public: number
  created_at: number
  updated_at: number
  /** Parts-mode manifest (ordered Telegram part refs) — enables cross-instance
   *  serving of permanent chunked files after restore. */
  parts_json?: string | null
  /** Telegram part references captured by the mirror (byte-level recovery). */
  parts?: Array<{ messageId: number; fileId: string; fileName: string; bytes: number }>
}

interface AccountSnapRow {
  id: string
  owner_key: string
  api_key_hash: string
  email: string | null
  email_lower: string | null
  password_hash: string | null
  name: string | null
  role: string
  idem_register: string | null
  created_at: number
  updated_at: number
}

interface SnapshotPayloadV1 {
  v: 1
  kind: 'v5-snapshot'
  ts: number
  kv: KvSnapRow[]
  blobs: BlobSnapRow[]
  accounts: AccountSnapRow[]
  /** Recently-deleted account ids — restore hard-deletes them so a purged
   *  account can never resurrect from a snapshot an older instance uploads
   *  (accounts have no deleted_at column; this list is the tombstone). */
  accountsDel?: Array<{ id: string; ua: number }>
}

export interface SnapshotStatus {
  enabled: boolean
  lastSnapshotAt: number | null
  lastSnapshotKv: number | null
  writesSinceSnapshot: number
  snapshotEveryWrites: number
  /** ts of the last snapshot this instance APPLIED (restored or uploaded). */
  lastAppliedSnapshotTs: number | null
}

interface BackupGlobal {
  __v5Backup?: {
    lastSnapshotAt: number | null
    lastSnapshotKv: number | null
    writesSince: number
    busy: boolean
    /** ts of the newest snapshot applied/restored/uploaded by this instance. */
    lastAppliedTs: number
    /** rate-limit for auth-triggered snapshots */
    authSnapshotQueuedAt: number
    /** A write landed while a snapshot was mid-flight — the busy-holder must
     *  chain ONE trailing snapshot so the latest writes are never stranded
     *  (dropped-on-busy snapshots were losing finalize manifests). */
    rerunAfterBusy: boolean
  }
  /** blobId → latest mirrored part (captured by mirror.ts on send success). */
  __v5BlobParts?: Map<string, { messageId: number; fileId: string; fileName: string; bytes: number }>
}

const g = globalThis as unknown as BackupGlobal

function state() {
  g.__v5Backup ??= { lastSnapshotAt: null, lastSnapshotKv: null, writesSince: 0, busy: false, lastAppliedTs: 0, authSnapshotQueuedAt: 0, rerunAfterBusy: false }
  return g.__v5Backup
}

/** ts of the newest snapshot this instance has applied or produced. */
export function getLastAppliedSnapshotTs(): number {
  return state().lastAppliedTs
}

/** Mirror.ts records each successfully mirrored staged blob part here. */
export function noteMirroredBlobPart(
  blobId: string,
  info: { messageId: number; fileId: string; fileName: string; bytes: number },
): void {
  g.__v5BlobParts ??= new Map()
  g.__v5BlobParts.set(blobId, info)
}

/** Mirror.ts counts completed KV mirror writes; drives the snapshot cadence. */
export function noteMirroredWrite(): void {
  state().writesSince += 1
}

export function snapshotStatus(): SnapshotStatus {
  const s = state()
  return {
    enabled: isV5BackupConfigured(),
    lastSnapshotAt: s.lastSnapshotAt,
    lastSnapshotKv: s.lastSnapshotKv,
    writesSinceSnapshot: s.writesSince,
    snapshotEveryWrites: SNAPSHOT_EVERY_WRITES,
    lastAppliedSnapshotTs: s.lastAppliedTs || null,
  }
}

/** Backup active = env enabled + Telegram bot configured. */
export function isV5BackupConfigured(): boolean {
  return isV5TelegramBackupEnabled() && isTelegramConfigured()
}

// ─── Snapshot pointer discovery (layered) ───────────────────────────────────
//
// Telegram bots can only READ the chat's single PINNED message — and that pin
// is owned by the V4 account index (3977/4096 chars in this chat). Two
// independent, coexisting pointers make the snapshot discoverable:
//
//   1. PINNED INDEX ENTRY (primary): a MINIMAL foreign entry
//      `__v5s__ → {f: fileId, m: messageId}` (~110 chars) inside the V4 index.
//      V4's sync merges foreign entries, so it survives V4 activity.
//   2. BOT BIO (fallback): setMyDescription carries the same pointer —
//      survives even if the index overflows (new V4 accounts).
//

export interface SnapshotPointer {
  f: string
  m: number
  ts?: number
  /** Blobs-only snapshot (KB-sized, fast-converging channel): file id + ts. */
  bf?: string
  bm?: number
  bts?: number
  /** KV delta doc (bounded recent KV changes — smallest, fastest channel). */
  df?: string
  dm?: number
  dts?: number
}

async function botApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token) return { ok: false, description: 'no bot token' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(4_000),
    })
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  } catch {
    return { ok: false, description: 'network error' }
  }
}

/** Write the snapshot pointer into the bot's own description (bio).
 *  Carries the blobs-snapshot AND kv-delta pointer fields when present
 *  (merged by the uploaders so no channel clobbers another). */
async function setBioPointer(p: SnapshotPointer): Promise<boolean> {
  const parts: string[] = [`"f":"${p.f}"`, `"m":${p.m}`, `"ts":${p.ts ?? 0}`]
  if (p.bf && p.bm) parts.push(`"bf":"${p.bf}"`, `"bm":${p.bm}`, `"bts":${p.bts ?? 0}`)
  if (p.df && p.dm) parts.push(`"df":"${p.df}"`, `"dm":${p.dm}`, `"dts":${p.dts ?? 0}`)
  const description = `${BIO_MARKER} {${parts.join(',')}}`.slice(0, 512)
  const r = await botApi('setMyDescription', { description })
  return r.ok
}

/** Read the snapshot pointer from the bot's description (fallback path). */
export async function getBioPointer(): Promise<SnapshotPointer | null> {
  const r = await botApi('getMyDescription', {})
  const desc = ((r.result as { description?: string } | undefined)?.description ?? '').trim()
  if (!desc.startsWith(BIO_MARKER)) return null
  try {
    const parsed = JSON.parse(desc.slice(BIO_MARKER.length).trim()) as SnapshotPointer
    return parsed?.f ? parsed : null
  } catch {
    return null
  }
}

/** Read the snapshot pointer from the pinned V4 account index (primary path). */
export async function getIndexPointer(): Promise<SnapshotPointer | null> {
  const index = await fetchAccountIndex()
  if (!index) return null
  const entry = (index.accounts as Record<string, unknown>)[V5_SNAPSHOT_ACCOUNT] as
    | { f?: string; fileId?: string; m?: number; messageId?: number }
    | undefined
  const f = entry?.f ?? entry?.fileId
  const m = entry?.m ?? entry?.messageId
  if (!f) return null
  return { f, m: m ?? 0 }
}

export interface SnapshotResult {
  ok: boolean
  reason?: string
  ts?: number
  kv?: number
  blobs?: number
  accounts?: number
  bytes?: number
  messageId?: number
  fileId?: string
  /** Pointer registered in the pinned V4 account index. */
  indexed?: boolean
  /** True when a concurrent uploader had already advanced the shared pointer
   *  past this payload — this document exists but was NOT pinned (no regress). */
  stalePinSkipped?: boolean
  /** Pointer registered in the bot bio (fallback). */
  bio?: boolean
}

/**
 * Dump the authoritative SQLite store → gzip → one Telegram document →
 * register its pointer BOTH in the pinned V4 account index (minimal entry)
 * AND in the bot bio (fallback). Safe to call concurrently (best-effort busy
 * guard) and idempotent.
 */
export async function uploadV5Snapshot(reason: 'auto' | 'manual' | 'post-migrate'): Promise<SnapshotResult> {
  if (!isV5BackupConfigured()) return { ok: false, reason: 'backup-not-configured' }
  const s = state()
  if (s.busy) {
    // NEVER drop: mark for a trailing run. The busy-holder chains one more
    // snapshot after finishing, which captures writes that landed mid-flight
    // (a dropped finalize snapshot stranded manifests cross-instance).
    s.rerunAfterBusy = true
    return { ok: false, reason: 'snapshot-in-progress' }
  }
  s.busy = true
  try {
    // Monotonicity guard: apply any NEWER shared snapshot FIRST so this
    // upload is a superset — a stale instance must never regress the shared
    // pointer to a snapshot that misses another instance's writes.
    try {
      const { probeAndApplyIfNewer } = await import('./sync')
      await probeAndApplyIfNewer()
    } catch {
      /* best-effort — proceed with what this instance has */
    }
    const db = await v5db()
    const kvRows = await db.execute(
      'SELECT owner, collection, key, value, size, created_at, updated_at, deleted_at FROM v5_kv',
    )
    const blobRows = await db.execute(
      'SELECT id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at, parts_json FROM v5_blobs ORDER BY created_at ASC',
    )
    const acctRows = await db.execute(
      'SELECT id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, idem_register, created_at, updated_at FROM v5_accounts ORDER BY created_at ASC',
    )

    const parts = g.__v5BlobParts
    const blobs: BlobSnapRow[] = blobRows.rows.map((r) => {
      const row: BlobSnapRow = {
        id: String(r.id),
        owner: String(r.owner),
        filename: r.filename === null ? null : String(r.filename),
        mime: r.mime === null ? null : String(r.mime),
        size: Number(r.size ?? 0),
        checksum: r.checksum === null ? null : String(r.checksum),
        status: String(r.status),
        storage_key: r.storage_key === null ? null : String(r.storage_key),
        chunks: Number(r.chunks ?? 0),
        is_public: Number(r.is_public ?? 0),
        created_at: Number(r.created_at ?? 0),
        updated_at: Number(r.updated_at ?? 0),
        parts_json: r.parts_json === null || r.parts_json === undefined ? null : String(r.parts_json),
      }
      const p = parts?.get(row.id)
      if (p && row.status === 'ready') row.parts = [p]
      return row
    })

    const ts = Date.now()
    const kvCount = kvRows.rows.length
    // STREAMED serialization: JSON.stringify of the whole store doubled peak
    // memory (rows + giant string + gzip buffer) and OOM-killed instances
    // mid-request. Rows stream into the gzip encoder one at a time; peak
    // memory stays near the row set itself.
    const gz = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = []
      const enc = createGzip({ level: 6 })
      enc.on('data', (c: Buffer) => chunks.push(c))
      enc.on('error', reject)
      enc.on('end', () => resolve(Buffer.concat(chunks)))
      try {
        enc.write(`{"v":1,"kind":"v5-snapshot","ts":${ts},"kv":[`)
        for (let i = 0; i < kvCount; i++) {
          const r = kvRows.rows[i]
          enc.write(
            (i > 0 ? ',' : '') +
              JSON.stringify({
                o: String(r.owner),
                c: String(r.collection),
                k: String(r.key),
                v: String(r.value),
                s: Number(r.size ?? 0),
                ca: Number(r.created_at ?? 0),
                ua: Number(r.updated_at ?? 0),
                d: r.deleted_at === null ? null : Number(r.deleted_at),
              }),
          )
        }
        enc.write(`],"blobs":${JSON.stringify(blobs)},"accounts":`)
        enc.write(
          JSON.stringify(
            acctRows.rows.map((r) => ({
              id: String(r.id),
              owner_key: String(r.owner_key),
              api_key_hash: String(r.api_key_hash),
              email: r.email === null ? null : String(r.email),
              email_lower: r.email_lower === null ? null : String(r.email_lower),
              password_hash: r.password_hash === null ? null : String(r.password_hash),
              name: r.name === null ? null : String(r.name),
              role: String(r.role),
              idem_register: r.idem_register === null ? null : String(r.idem_register),
              created_at: Number(r.created_at ?? 0),
              updated_at: Number(r.updated_at ?? 0),
            })),
          ),
        )
        enc.write(`,"accountsDel":${JSON.stringify(recentAccountDeletes())}`)
        enc.write('}')
        enc.end()
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
    const sent = await sendDocumentFile({
      file: new Blob([new Uint8Array(gz)]),
      fileName: `v5-snapshot-${ts}.json.gz`,
      mimeType: 'application/gzip',
      caption: `${CAPTION_MARKER}|ts=${ts}|kv=${kvCount}|blobs=${blobs.length}|reason=${reason}`,
    })
    if (!sent.ok || !sent.document) {
      return { ok: false, reason: (!sent.ok && sent.error) || 'sendDocument failed' }
    }
    const payload = { ts, kv: { length: kvCount }, blobs: { length: blobs.length } }

    // ── Pointer layer 1: minimal foreign entry in the pinned V4 index.
    // The shared pin is nearly full (3977/4096 chars in this chat), so the
    // entry carries ONLY {f: fileId, m: messageId} (~110 chars). V4's sync
    // merges foreign accounts into the index, so the entry survives V4
    // activity; V4 never reads fields of accounts it does not own.
    const iso = new Date(ts).toISOString()
    const pointer: SnapshotPointer = { f: sent.document.fileId, m: sent.document.messageId, ts }
    let indexed = false
    try {
      const index: AccountIndex =
        (await fetchAccountIndex()) ?? {
          cloudkv: true,
          kind: 'account-index',
          version: 4,
          exportedAt: iso,
          accounts: {},
        }
      index.exportedAt = iso
      ;(index.accounts as Record<string, unknown>)[V5_SNAPSHOT_ACCOUNT] = { f: pointer.f, m: pointer.m }
      indexed = (await pinAccountIndex(index)) !== null
    } catch {
      indexed = false
    }

    // ── Pointer layer 2: the bot's own bio (setMyDescription) — survives even
    // if the pinned index overflows (new V4 accounts) or loses the entry.
    // MERGE: keep the fast blobs-snapshot pointer fields so a full-snapshot
    // pin never clobbers the small channel.
    let bio = false
    try {
      const prev = await getBioPointer()
      bio = await setBioPointer(
        prev?.bf && prev.bm ? { ...pointer, bf: prev.bf, bm: prev.bm, bts: prev.bts } : pointer,
      )
    } catch {
      bio = false
    }

    if (!indexed && !bio) {
      // Document was sent — recoverable manually via its fileId (admin API).
      return {
        ok: false,
        reason: 'snapshot sent but no pointer could be registered (index + bio both failed)',
        ts: payload.ts,
        messageId: sent.document.messageId,
        fileId: sent.document.fileId,
      }
    }

    // Stale-pin guard: a CONCURRENT uploader may have already advanced the
    // shared pointer past this payload's ts — never regress it.
    try {
      const current = (await getBioPointer()) ?? (await getIndexPointer())
      if (current && (current.ts ?? 0) >= ts) {
        return { ok: true, ts, kv: kvCount, blobs: blobs.length, bytes: gz.length, messageId: sent.document.messageId, fileId: sent.document.fileId, indexed: false, bio: false, stalePinSkipped: true }
      }
    } catch {
      /* pin guard best-effort */
    }
    s.lastSnapshotAt = ts
    s.lastSnapshotKv = kvCount
    s.lastAppliedTs = ts
    s.writesSince = 0
    console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.snapshot-uploaded', level: 'info', reason, ts, kv: kvCount, blobs: blobs.length, bytes: gz.length, indexed, bio }))
    return {
      ok: true,
      ts,
      kv: kvCount,
      blobs: blobs.length,
      accounts: acctRows.rows.length,
      bytes: gz.length,
      messageId: sent.document.messageId,
      fileId: sent.document.fileId,
      indexed,
      bio,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.snapshot-failed', level: 'warn', reason: message.slice(0, 200) }))
    return { ok: false, reason: message }
  } finally {
    s.busy = false
    // Trailing run: a write landed while we were mid-flight — chain ONE more
    // snapshot (durable, so the invocation survives to finish it).
    if (s.rerunAfterBusy && isV5BackupConfigured()) {
      s.rerunAfterBusy = false
      try {
        const { durable } = await import('./durable')
        durable(
          (async () => {
            for (let i = 0; i < 3; i++) {
              const res = await uploadV5Snapshot('auto')
              if (res.ok || res.reason !== 'snapshot-in-progress') break
              await new Promise((r) => setTimeout(r, 3000))
            }
          })(),
        )
      } catch {
        /* best-effort */
      }
    }
  }
}


// ─── Blobs-only snapshot (fast convergence channel) ─────────────────────────
//
// Full-state snapshots carry EVERYTHING (13MB+ at current data) — they take
// 5-15s to upload and cannot make a just-finalized file instantly servable
// from any instance. The blobs channel dumps ONLY v5_blobs rows + the
// v5_blobmeta KV collection (manifests/part records/dedup — a few KB), so a
// finalize lands in every instance within ~1-2s. The full snapshot remains
// the source of truth; the blobs channel is an accelerator that is always a
// SUBSET of a later full snapshot.

export interface BlobsSnapshotPayloadV1 {
  v: 1 | 2
  kind: 'v5-blobs-snapshot'
  ts: number
  blobs: BlobSnapRow[]
  /** v5_blobmeta rows: {o: owner, k: key, v: JSON value, ua: updated_at}. */
  meta: Array<{ o: string; k: string; v: string; ua: number }>
  /** v2: blob row tombstones — apply as status='deleted' when newer. */
  del?: Array<{ id: string; ua: number }>
  /** v2: recently-deleted v5_blobmeta keys — apply as soft-delete when newer. */
  metaDel?: Array<{ o: string; k: string; ua: number }>
}

// ─── Recent account-delete ring (feeds the full snapshot accountsDel list) ───

interface AcctDelGlobal {
  __v5AcctDel?: Array<{ id: string; ua: number }>
}
const ACCT_DEL_WINDOW_MS = 24 * 60 * 60 * 1000
const ACCT_DEL_MAX = 500

export function noteAccountDelete(accountId: string): void {
  const g = globalThis as unknown as AcctDelGlobal
  g.__v5AcctDel ??= []
  g.__v5AcctDel.push({ id: accountId, ua: Date.now() })
  if (g.__v5AcctDel.length > ACCT_DEL_MAX) g.__v5AcctDel = g.__v5AcctDel.slice(-ACCT_DEL_MAX)
}

function recentAccountDeletes(): Array<{ id: string; ua: number }> {
  const g = globalThis as unknown as AcctDelGlobal
  const all = g.__v5AcctDel ?? []
  const cutoff = Date.now() - ACCT_DEL_WINDOW_MS
  const fresh = all.filter((e) => e.ua >= cutoff)
  if (fresh.length !== all.length) g.__v5AcctDel = fresh
  return fresh
}

// ─── Recent blobmeta delete ring (feeds the blobs-snapshot metaDel list) ─────
// kvDelete on v5_blobmeta keys (manifests / part records / dedup entries)
// writes here; uploadBlobsSnapshot drains entries from the last
// BLOBS_META_DEL_WINDOW_MS so deletes converge cross-instance in ~1-2s
// instead of waiting for the next full snapshot.

interface BlobsMetaDelGlobal {
  __v5BlobsMetaDel?: Array<{ o: string; k: string; ua: number }>
}
const BLOBS_META_DEL_WINDOW_MS = 20 * 60 * 1000
const BLOBS_META_DEL_MAX = 2000

export function noteBlobMetaDelete(owner: string, key: string): void {
  const g = globalThis as unknown as BlobsMetaDelGlobal
  g.__v5BlobsMetaDel ??= []
  g.__v5BlobsMetaDel.push({ o: owner, k: key, ua: Date.now() })
  if (g.__v5BlobsMetaDel.length > BLOBS_META_DEL_MAX) {
    g.__v5BlobsMetaDel = g.__v5BlobsMetaDel.slice(-BLOBS_META_DEL_MAX)
  }
}

function recentBlobMetaDeletes(): Array<{ o: string; k: string; ua: number }> {
  const g = globalThis as unknown as BlobsMetaDelGlobal
  const all = g.__v5BlobsMetaDel ?? []
  const cutoff = Date.now() - BLOBS_META_DEL_WINDOW_MS
  const fresh = all.filter((e) => e.ua >= cutoff)
  if (fresh.length !== all.length) g.__v5BlobsMetaDel = fresh
  return fresh
}

/** Separate busy flag — KB-sized uploads never queue behind 13MB ones. */
function blobsBusy(): { busy: boolean } & Record<string, unknown> {
  const g2 = globalThis as unknown as { __v5BlobsSnapBusy?: { busy: boolean } }
  g2.__v5BlobsSnapBusy ??= { busy: false }
  return g2.__v5BlobsSnapBusy
}

const BLOBS_MARKER = 'ONYXBASE_V5_BLOBS'

/** Dump blobs + blobmeta → one small Telegram doc → merge into the bio pointer. */
export async function uploadBlobsSnapshot(reason: 'finalize' | 'init'): Promise<{ ok: boolean; reason?: string; ts?: number }> {
  if (!isV5BackupConfigured()) return { ok: false, reason: 'backup-not-configured' }
  const b = blobsBusy()
  if (b.busy) return { ok: false, reason: 'snapshot-in-progress' }
  b.busy = true
  try {
    // Monotonicity: never regress the blobs pointer.
    const prev = await getBioPointer()
    if (prev?.bts && Date.now() <= prev.bts) return { ok: true, ts: prev.bts }
    const db = await v5db()
    const blobRows = await db.execute(
      'SELECT id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at, parts_json FROM v5_blobs ORDER BY created_at ASC',
    )
    const metaRows = await db.execute(
      "SELECT owner, key, value, updated_at FROM v5_kv WHERE collection = 'v5_blobmeta' AND deleted_at IS NULL",
    )
    const payload: BlobsSnapshotPayloadV1 = {
      v: 2,
      kind: 'v5-blobs-snapshot',
      ts: Date.now(),
      blobs: blobRows.rows
        .map((r) => {
          const row: BlobSnapRow = {
            id: String(r.id),
            owner: String(r.owner),
            filename: r.filename === null ? null : String(r.filename),
            mime: r.mime === null ? null : String(r.mime),
            size: Number(r.size ?? 0),
            checksum: r.checksum === null ? null : String(r.checksum),
            status: String(r.status),
            storage_key: r.storage_key === null ? null : String(r.storage_key),
            chunks: Number(r.chunks ?? 0),
            is_public: Number(r.is_public ?? 0),
            created_at: Number(r.created_at ?? 0),
            updated_at: Number(r.updated_at ?? 0),
            parts_json: r.parts_json === null || r.parts_json === undefined ? null : String(r.parts_json),
          }
          return row
        })
        // Tombstoned rows ride the del list, not the blobs list — a receiving
        // instance must APPLY the tombstone (UPDATE), and INSERT OR IGNORE on
        // a deleted row would leave its live local copy untouched.
        .filter((row) => row.status !== 'deleted'),
      meta: metaRows.rows.map((r) => ({
        o: String(r.owner),
        k: String(r.key),
        v: String(r.value),
        ua: Number(r.updated_at ?? 0),
      })),
      del: blobRows.rows
        .filter((r) => String(r.status) === 'deleted')
        .map((r) => ({ id: String(r.id), ua: Number(r.updated_at ?? 0) })),
      metaDel: recentBlobMetaDeletes(),
    }
    const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'))
    const sent = await sendDocumentFile({
      file: new Blob([new Uint8Array(gz)]),
      fileName: `v5-blobs-${payload.ts}.json.gz`,
      mimeType: 'application/gzip',
      caption: `${BLOBS_MARKER}|ts=${payload.ts}|blobs=${payload.blobs.length}|meta=${payload.meta.length}|reason=${reason}`,
    })
    if (!sent.ok || !sent.document) return { ok: false, reason: (!sent.ok && sent.error) || 'sendDocument failed' }
    // Merge into the bio pointer (keep the full-snapshot + delta fields).
    const cur = (await getBioPointer()) ?? prev
    const base: SnapshotPointer = cur?.f ? cur : { f: '', m: 0, ts: 0 }
    const ok = await setBioPointer({ ...base, bf: sent.document.fileId, bm: sent.document.messageId, bts: payload.ts })
    if (!ok) return { ok: false, reason: 'bio pointer write failed' }
    // This instance obviously has this data already.
    setLastAppliedBlobsTs(payload.ts)
    console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.blobs-snapshot-uploaded', level: 'info', reason, ts: payload.ts, blobs: payload.blobs.length, meta: payload.meta.length, bytes: gz.length }))
    return { ok: true, ts: payload.ts }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message }
  } finally {
    b.busy = false
  }
}

/** Track the newest applied blobs-snapshot ts (per instance). */
export function getLastAppliedBlobsTs(): number {
  const g2 = globalThis as unknown as { __v5BlobsTs?: number }
  return g2.__v5BlobsTs ?? 0
}

export function setLastAppliedBlobsTs(ts: number): void {
  const g2 = globalThis as unknown as { __v5BlobsTs?: number }
  if (ts > (g2.__v5BlobsTs ?? 0)) g2.__v5BlobsTs = ts
}

/** Apply a blobs-only snapshot: rows earliest-wins, blobmeta upsert-if-newer. */
export async function applyBlobsSnapshot(fileId: string): Promise<{ ok: boolean; reason?: string; ts?: number }> {
  try {
    const db = await v5db()
    const dl = await getFileDownloadUrl(fileId)
    if (!dl) return { ok: false, reason: 'getFile failed' }
    const res = await fetch(dl.url, { signal: AbortSignal.timeout(20_000) })
    if (!res.ok) return { ok: false, reason: `download HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const raw = gunzipSync(buf).toString('utf-8')
    const payload = JSON.parse(raw) as BlobsSnapshotPayloadV1
    if ((payload.v !== 1 && payload.v !== 2) || payload.kind !== 'v5-blobs-snapshot') return { ok: false, reason: 'bad payload' }
    // Rows: earliest-wins (consistent with the full restore's merge rule).
    if (Array.isArray(payload.blobs) && payload.blobs.length > 0) {
      const stmts = payload.blobs
        .slice()
        .sort((a, b) => a.created_at - b.created_at)
        .map(
          (bl) =>
            `INSERT OR IGNORE INTO v5_blobs (id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at, parts_json) VALUES (` +
            `'${sqlEscape(bl.id)}', '${sqlEscape(bl.owner)}', ${bl.filename === null ? 'NULL' : `'${sqlEscape(bl.filename)}'`}, ` +
            `${bl.mime === null ? 'NULL' : `'${sqlEscape(bl.mime)}'`}, ${bl.size}, ${bl.checksum === null ? 'NULL' : `'${sqlEscape(bl.checksum)}'`}, ` +
            `'${sqlEscape(bl.status)}', ${bl.storage_key === null ? 'NULL' : `'${sqlEscape(bl.storage_key)}'`}, ${bl.chunks}, ${bl.is_public}, ` +
            `${bl.created_at}, ${bl.updated_at}, ${!bl.parts_json ? 'NULL' : `'${sqlEscape(bl.parts_json)}'`})`,
        )
      for (let i = 0; i < stmts.length; i += 100) {
        await db.batch(stmts.slice(i, i + 100).map((sql) => ({ sql, args: [] })), 'write')
      }
    }
    // Blobmeta: upsert-if-newer (a finalized manifest must REPLACE an older
    // skeleton for the same key — earliest-wins would strand it at 'created').
    for (const m of Array.isArray(payload.meta) ? payload.meta : []) {
      if (!m || typeof m.o !== 'string' || typeof m.k !== 'string' || typeof m.v !== 'string') continue
      await db.execute({
        sql: `INSERT INTO v5_kv (owner, collection, key, value, size, created_at, updated_at)
              VALUES (?, 'v5_blobmeta', ?, ?, ?, ?, ?)
              ON CONFLICT(owner, collection, key) DO UPDATE SET
                value = excluded.value, size = excluded.size, updated_at = excluded.updated_at, deleted_at = NULL
              WHERE excluded.updated_at > v5_kv.updated_at`,
        args: [m.o, m.k, m.v, Buffer.byteLength(m.v, 'utf-8'), m.ua, m.ua],
      })
    }
    // v2 DELETE CONVERGENCE: blob row tombstones (status='deleted' when
    // newer than the local row) + blobmeta soft-deletes. Without this, a
    // deleted blob would resurrect on instances that never saw the delete.
    if (Array.isArray(payload.del) && payload.del.length > 0) {
      for (const d of payload.del) {
        if (!d || typeof d.id !== 'string' || typeof d.ua !== 'number') continue
        await db
          .execute({
            sql: `UPDATE v5_blobs SET status = 'deleted', updated_at = ? WHERE id = ? AND updated_at < ? AND status != 'deleted'`,
            args: [d.ua, d.id, d.ua],
          })
          .catch(() => undefined)
      }
    }
    if (Array.isArray(payload.metaDel) && payload.metaDel.length > 0) {
      for (const d of payload.metaDel) {
        if (!d || typeof d.o !== 'string' || typeof d.k !== 'string' || typeof d.ua !== 'number') continue
        await db
          .execute({
            sql: `UPDATE v5_kv SET deleted_at = ?, updated_at = ? WHERE owner = ? AND collection = 'v5_blobmeta' AND key = ? AND deleted_at IS NULL AND updated_at < ?`,
            args: [d.ua, d.ua, d.o, d.k, d.ua],
          })
          .catch(() => undefined)
      }
    }
    setLastAppliedBlobsTs(payload.ts)
    // CRITICAL: direct db writes bypass the KV hot cache — a negative cache
    // entry (30s) would keep serving the miss AFTER this apply. Same rule
    // as the full restore.
    clearKvCache()
    return { ok: true, ts: payload.ts }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

// ─── KV delta channel (fast cross-instance convergence for regular KV) ──────
//
// Full snapshots carry the entire v5_kv table (13MB+ at current data) and ride
// an idle cadence — a KV write (resource record, profile, tombstone) only
// converged cross-instance after the next FULL snapshot (15-30s), which is
// exactly the window where listings served stale state: freshly-created
// records 404'd on other instances ("0 uploaded" / 20-40s verification) and
// freshly-deleted records resurrected on refresh.
//
// The delta channel is a BOUNDED doc (rows touched in the last 10 minutes,
// capped at 400 rows / ~1MB) that uploads within ~1-2s of a write. Receivers
// apply it with the same upsert-if-newer semantics as the full snapshot, so it
// is always a SUBSET of a later full snapshot — an accelerator, never a
// regression risk. v5_blobmeta is excluded (it rides the blobs channel).

export interface KvDeltaPayloadV1 {
  v: 1
  kind: 'v5-kv-delta'
  ts: number
  kv: Array<{ o: string; c: string; k: string; v: string; s: number; ca: number; ua: number; d: number | null }>
}

const KV_DELTA_WINDOW_MS = 10 * 60 * 1000
const KV_DELTA_MAX_ROWS = 400
const KV_DELTA_MAX_BYTES = 1024 * 1024
const KV_DELTA_MIN_INTERVAL_MS = 2_500
const DELTA_MARKER = 'ONYXBASE_V5_DELTA'

interface DeltaBusyGlobal {
  __v5DeltaBusy?: { busy: boolean; rerun: boolean }
  __v5DeltaQueuedAt?: number
  __v5DeltaTs?: number
}

function deltaState(): { busy: boolean; rerun: boolean } {
  const g = globalThis as unknown as DeltaBusyGlobal
  g.__v5DeltaBusy ??= { busy: false, rerun: false }
  return g.__v5DeltaBusy
}

/**
 * Dump recently-touched KV rows → one small Telegram doc → merge the delta
 * pointer (df/dm/dts) into the bio. Includes soft-deleted rows (deletes must
 * converge fast too). Rows applied from OTHER instances' deltas keep their
 * original updated_at, so a later delta from this instance is a superset —
 * the single shared pointer converges without loss under concurrent writers.
 */
export async function uploadKvDelta(reason: 'kv-write' | 'manual'): Promise<{ ok: boolean; reason?: string; ts?: number; rows?: number }> {
  if (!isV5BackupConfigured()) return { ok: false, reason: 'backup-not-configured' }
  const s = deltaState()
  if (s.busy) {
    s.rerun = true // never drop: chain one trailing upload for mid-flight writes
    return { ok: false, reason: 'delta-in-progress' }
  }
  s.busy = true
  try {
    const db = await v5db()
    const cutoff = Date.now() - KV_DELTA_WINDOW_MS
    const rs = await db.execute({
      sql: `SELECT owner, collection, key, value, size, created_at, updated_at, deleted_at
            FROM v5_kv
            WHERE collection != 'v5_blobmeta' AND updated_at > ?
            ORDER BY updated_at DESC
            LIMIT ?`,
      args: [cutoff, KV_DELTA_MAX_ROWS],
    })
    const rows: KvDeltaPayloadV1['kv'] = []
    let bytes = 0
    for (const r of rs.rows) {
      const row = {
        o: String(r.owner),
        c: String(r.collection),
        k: String(r.key),
        v: String(r.value),
        s: Number(r.size ?? 0),
        ca: Number(r.created_at ?? 0),
        ua: Number(r.updated_at ?? 0),
        d: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
      }
      const sz = row.v.length + row.k.length + row.o.length + row.c.length + 64
      if (bytes + sz > KV_DELTA_MAX_BYTES && rows.length > 0) break // bounded doc
      rows.push(row)
      bytes += sz
    }
    if (rows.length === 0) return { ok: true, ts: getLastAppliedDeltaTs(), rows: 0 }
    const payload: KvDeltaPayloadV1 = { v: 1, kind: 'v5-kv-delta', ts: Date.now(), kv: rows }
    const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'))
    const sent = await sendDocumentFile({
      file: new Blob([new Uint8Array(gz)]),
      fileName: `v5-delta-${payload.ts}.json.gz`,
      mimeType: 'application/gzip',
      caption: `${DELTA_MARKER}|ts=${payload.ts}|rows=${rows.length}|reason=${reason}`,
    })
    if (!sent.ok || !sent.document) return { ok: false, reason: (!sent.ok && sent.error) || 'sendDocument failed' }
    // Merge into the bio pointer (keep full-snapshot + blobs fields).
    const cur = await getBioPointer()
    const base: SnapshotPointer = cur?.f ? cur : { f: '', m: 0, ts: 0 }
    const ok = await setBioPointer({ ...base, df: sent.document.fileId, dm: sent.document.messageId, dts: payload.ts })
    if (!ok) return { ok: false, reason: 'bio pointer write failed' }
    setLastAppliedDeltaTs(payload.ts)
    console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.kv-delta-uploaded', level: 'info', reason, ts: payload.ts, rows: rows.length, bytes: gz.length }))
    return { ok: true, ts: payload.ts, rows: rows.length }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message }
  } finally {
    s.busy = false
    if (s.rerun) {
      s.rerun = false
      try {
        const { durable } = await import('./durable')
        durable(uploadKvDelta('kv-write').catch(() => undefined))
      } catch {
        /* best-effort */
      }
    }
  }
}

/** Track the newest applied kv-delta ts (per instance). */
export function getLastAppliedDeltaTs(): number {
  const g = globalThis as unknown as DeltaBusyGlobal
  return g.__v5DeltaTs ?? 0
}

export function setLastAppliedDeltaTs(ts: number): void {
  const g = globalThis as unknown as DeltaBusyGlobal
  if (ts > (g.__v5DeltaTs ?? 0)) g.__v5DeltaTs = ts
}

/** Apply a kv-delta doc: upsert-if-newer (incl. soft-deletes), then cache drop. */
export async function applyKvDelta(fileId: string): Promise<{ ok: boolean; reason?: string; ts?: number }> {
  try {
    const db = await v5db()
    const dl = await getFileDownloadUrl(fileId)
    if (!dl) return { ok: false, reason: 'getFile failed' }
    const res = await fetch(dl.url, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return { ok: false, reason: `download HTTP ${res.status}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const payload = JSON.parse(gunzipSync(buf).toString('utf-8')) as KvDeltaPayloadV1
    if (payload.v !== 1 || payload.kind !== 'v5-kv-delta' || !Array.isArray(payload.kv)) {
      return { ok: false, reason: 'bad payload' }
    }
    const BATCH = 200
    for (let i = 0; i < payload.kv.length; i += BATCH) {
      const stmts = payload.kv.slice(i, i + BATCH).map(
        (r) =>
          `INSERT INTO v5_kv (owner, collection, key, value, size, created_at, updated_at, deleted_at) VALUES (` +
          `'${sqlEscape(r.o)}', '${sqlEscape(r.c)}', '${sqlEscape(r.k)}', '${sqlEscape(r.v)}', ${r.s}, ${r.ca}, ${r.ua}, ${r.d ?? 'NULL'} ` +
          `) ON CONFLICT (owner, collection, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at ` +
          `WHERE excluded.updated_at >= v5_kv.updated_at`,
      )
      if (stmts.length) await db.batch(stmts.map((sql) => ({ sql, args: [] })), 'write')
    }
    setLastAppliedDeltaTs(payload.ts)
    clearKvCache()
    return { ok: true, ts: payload.ts }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Rate-limited durable delta upload — called (fire-and-forget) after every KV
 * write outside v5_blobmeta. At most one upload per KV_DELTA_MIN_INTERVAL_MS
 * per instance; a write that lands mid-upload chains a trailing run.
 */
export function queueKvDeltaSnapshot(): void {
  if (!isV5BackupConfigured()) return
  const g = globalThis as unknown as DeltaBusyGlobal
  const now = Date.now()
  if (now - (g.__v5DeltaQueuedAt ?? 0) < KV_DELTA_MIN_INTERVAL_MS) return
  g.__v5DeltaQueuedAt = now
  try {
    void import('./durable').then(({ durable }) => {
      durable(
        (async () => {
          for (let i = 0; i < 3; i++) {
            const res = await uploadKvDelta('kv-write')
            if (res.ok || (res.reason !== 'delta-in-progress' && res.reason !== 'backup-not-configured')) break
            await new Promise((r) => setTimeout(r, 2500))
          }
        })().catch(() => undefined),
      )
    })
  } catch {
    /* delta optional — the full snapshot remains the source of truth */
  }
}

/** Called by the mirror drain when the queue goes idle. */
export async function maybeSnapshotOnIdle(): Promise<void> {
  const s = state()
  const dueByWrites = s.writesSince >= SNAPSHOT_EVERY_WRITES
  // Convergence cadence: with low traffic a single write would otherwise wait
  // for nine more — cap the wait so other instances converge within ~15s.
  const dueByAge = s.writesSince >= 1 && Date.now() - (s.lastSnapshotAt ?? 0) >= SNAPSHOT_MIN_INTERVAL_MS
  if (dueByWrites || dueByAge) {
    s.writesSince = 0
    const res = await uploadV5Snapshot('auto')
    if (!res.ok) {
      console.warn(
        JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.auto-snapshot', level: 'warn', reason: res.reason }),
      )
    }
  }
}

/**
 * Immediate durable snapshot after account writes (register / login key
 * mint). Rate-limited to one per AUTH_SNAPSHOT_MIN_INTERVAL_MS per instance
 * so the shared pointer advances within seconds of a registration — that is
 * what makes a cross-instance login work soon after a cross-instance signup.
 *
 * DURABILITY: the snapshot runs via durable() (waitUntil) — called
 * synchronously from the request path, the platform keeps the invocation
 * alive until the snapshot is pinned. Fire-and-forget snapshots were killed
 * by the serverless freeze the moment the register response shipped, which
 * stranded accounts on the instance that created them.
 */
export function queueAuthSnapshot(): void {
  if (!isV5BackupConfigured()) return
  const s = state()
  const now = Date.now()
  if (now - s.authSnapshotQueuedAt < AUTH_SNAPSHOT_MIN_INTERVAL_MS) return
  s.authSnapshotQueuedAt = now
  durable((async () => {
    try {
      const res = await uploadV5Snapshot('auto')
      if (!res.ok && res.reason !== 'snapshot-in-progress' && res.reason !== 'backup-not-configured') {
        console.warn(
          JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.auth-snapshot', level: 'warn', reason: res.reason }),
        )
      }
    } catch {
      /* best-effort */
    }
  })())
}

// ─── Restore ─────────────────────────────────────────────────────────────────

export interface RestoreResult {
  ok: boolean
  reason?: string
  snapshotTs?: number
  /** Which pointer layer located the snapshot. */
  via?: 'explicit' | 'index' | 'bio' | null
  applied?: { kv: number; blobs: number; accounts: number; blobBytesRestaged: number }
}

/**
 * Rebuild the SQLite store from the latest Telegram snapshot.
 * Pointer discovery: explicit fileId param → pinned V4 index entry → bot bio.
 * Upserts are conditional on `updated_at` so newer local writes always win;
 * account and blob rows are insert-if-absent only (live rows are authoritative).
 */
export async function restoreV5FromTelegram(opts?: { fileId?: string }): Promise<RestoreResult> {
  const t0 = Date.now()
  const step = (name: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.restore-step', level: 'info', step: name, ms: Date.now() - t0, ...extra }))
  if (!isTelegramConfigured()) return { ok: false, reason: 'telegram-not-configured' }
  let pointer: SnapshotPointer | null = null
  let via: 'explicit' | 'index' | 'bio' | null = null
  if (opts?.fileId) {
    pointer = { f: opts.fileId, m: 0 }
    via = 'explicit'
  }
  if (!pointer) {
    pointer = await getIndexPointer()
    if (pointer) via = 'index'
  }
  if (!pointer) {
    pointer = await getBioPointer()
    if (pointer) via = 'bio'
  }
  step('pointer', { via })
  if (!pointer) return { ok: false, reason: 'no-snapshot-registered' }

  const dl = await getFileDownloadUrl(pointer.f)
  step('getFile', { ok: !!dl })
  if (!dl) return { ok: false, reason: 'getFile failed' }
  const res = await fetch(dl.url, { signal: AbortSignal.timeout(20_000) })
  const buf = Buffer.from(await res.arrayBuffer())
  step('download', { bytes: buf.length, status: res.status })
  if (!res.ok) return { ok: false, reason: `snapshot download failed (${res.status})` }
  let payload: SnapshotPayloadV1
  try {
    payload = JSON.parse(gunzipSync(buf).toString('utf-8')) as SnapshotPayloadV1
  } catch {
    return { ok: false, reason: 'snapshot payload invalid' }
  }
  step('parse', { kv: payload.kv?.length, blobs: payload.blobs?.length, accounts: payload.accounts?.length })
  if (payload?.kind !== 'v5-snapshot' || payload?.v !== 1 || !Array.isArray(payload.kv)) {
    return { ok: false, reason: 'snapshot payload unrecognized' }
  }

  const db = await v5db()
  step('db-ready')
  let appliedKv = 0
  const BATCH = 200
  for (let i = 0; i < payload.kv.length; i += BATCH) {
    const chunk = payload.kv.slice(i, i + BATCH)
    const stmts = chunk.map(
      (r) =>
        `INSERT INTO v5_kv (owner, collection, key, value, size, created_at, updated_at, deleted_at) VALUES (` +
        `'${sqlEscape(r.o)}', '${sqlEscape(r.c)}', '${sqlEscape(r.k)}', '${sqlEscape(r.v)}', ${r.s}, ${r.ca}, ${r.ua}, ${r.d ?? 'NULL'} ` +
        `) ON CONFLICT (owner, collection, key) DO UPDATE SET value = excluded.value, size = excluded.size, updated_at = excluded.updated_at, deleted_at = excluded.deleted_at ` +
        `WHERE excluded.updated_at >= v5_kv.updated_at`,
    )
    if (stmts.length) {
      const tb = Date.now()
      await db.batch(stmts.map((s) => ({ sql: s, args: [] })), 'write')
      appliedKv += stmts.length
      step('kv-batch', { batch: stmts.length, ms: Date.now() - tb })
    }
  }

  let appliedAccounts = 0
  if (Array.isArray(payload.accounts) && payload.accounts.length) {
    const stmts = payload.accounts.map(
      (a) =>
        // INSERT OR IGNORE (not ON CONFLICT(id)): in the rare split-brain
        // window two instances may create different ids for the same email —
        // ORDER BY created_at ASC makes the EARLIEST (original) win on the
        // email_lower unique index instead of aborting the whole batch.
        `INSERT OR IGNORE INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, idem_register, created_at, updated_at) VALUES (` +
        `'${sqlEscape(a.id)}', '${sqlEscape(a.owner_key)}', '${sqlEscape(a.api_key_hash)}', ${a.email === null ? 'NULL' : `'${sqlEscape(a.email)}'`}, ` +
        `${a.email_lower === null ? 'NULL' : `'${sqlEscape(a.email_lower)}'`}, ${a.password_hash === null ? 'NULL' : `'${sqlEscape(a.password_hash)}'`}, ` +
        `${a.name === null ? 'NULL' : `'${sqlEscape(a.name)}'`}, '${sqlEscape(a.role)}', ${a.idem_register === null ? 'NULL' : `'${sqlEscape(a.idem_register)}'`}, ` +
        `${a.created_at}, ${a.updated_at})`,
    )
    for (let i = 0; i < stmts.length; i += BATCH) {
      const r = await db.batch(stmts.slice(i, i + BATCH).map((s) => ({ sql: s, args: [] })), 'write')
      appliedAccounts += r.filter((x) => Number(x.rowsAffected ?? 0) > 0).length
    }
  }

  // Account deletions carried by the snapshot (purge tombstones): hard-delete
  // the account row AND every key row minted for it, so a purged account can
  // never resurrect on any instance (login, bearer, everything stops working).
  if (Array.isArray(payload.accountsDel) && payload.accountsDel.length) {
    for (const a of payload.accountsDel) {
      if (!a || typeof a.id !== 'string') continue
      await db
        .execute({ sql: `DELETE FROM v5_accounts WHERE id = ? OR owner_key = ?`, args: [a.id, a.id] })
        .catch(() => undefined)
    }
  }

  let appliedBlobs = 0
  let blobBytesRestaged = 0
  if (Array.isArray(payload.blobs) && payload.blobs.length) {
    const stmts = payload.blobs.map(
      (b) =>
        `INSERT OR IGNORE INTO v5_blobs (id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at, parts_json) VALUES (` +
        `'${sqlEscape(b.id)}', '${sqlEscape(b.owner)}', ${b.filename === null ? 'NULL' : `'${sqlEscape(b.filename)}'`}, ` +
        `${b.mime === null ? 'NULL' : `'${sqlEscape(b.mime)}'`}, ${b.size}, ${b.checksum === null ? 'NULL' : `'${sqlEscape(b.checksum)}'`}, ` +
        `'${sqlEscape(b.status)}', ${b.storage_key === null ? 'NULL' : `'${sqlEscape(b.storage_key)}'`}, ${b.chunks}, ${b.is_public}, ` +
        `${b.created_at}, ${b.updated_at}, ${!b.parts_json ? 'NULL' : `'${sqlEscape(b.parts_json)}'`})`,
    )
    for (let i = 0; i < stmts.length; i += BATCH) {
      const r = await db.batch(stmts.slice(i, i + BATCH).map((s) => ({ sql: s, args: [] })), 'write')
      appliedBlobs += r.filter((x) => Number(x.rowsAffected ?? 0) > 0).length
    }
    // TOMBSTONE CONVERGENCE: rows the uploader deleted (status='deleted')
    // must override a live local copy, or a restore would resurrect deleted
    // blobs on instances that never saw the delete (same rule as the
    // blobs-snapshot del list — INSERT OR IGNORE above cannot do it).
    for (const b of payload.blobs) {
      if (b.status !== 'deleted') continue
      await db
        .execute({
          sql: `UPDATE v5_blobs SET status = 'deleted', updated_at = ? WHERE id = ? AND updated_at < ? AND status != 'deleted'`,
          args: [b.updated_at, b.id, b.updated_at],
        })
        .catch(() => undefined)
    }
    // Byte-level recovery: re-stage ready blobs whose parts are referenced.
    // (Parts-mode blobs are served from their Telegram manifests — no staging.)
    for (const b of payload.blobs) {
      if (b.status !== 'ready' || !b.parts?.length) continue
      if (b.storage_key === 'parts' || b.parts_json) continue
      try {
        const stagingDir = process.env.V5_BLOB_STAGING_DIR || path.join(process.cwd(), '.data', 'v5-blobs')
        // MUST match stagingPath() in blobs.ts (`${blobId}.bin`) — otherwise a
        // restored blob 404s at serve time despite the bytes being restaged.
        const target = path.join(stagingDir, `${b.id}.bin`)
        if (fs.existsSync(target)) continue // local copy already present
        const part = b.parts[0]
        const pdl = await getFileDownloadUrl(part.fileId)
        if (!pdl) continue
        const pres = await fetch(pdl.url, { signal: AbortSignal.timeout(60_000) })
        if (!pres.ok) continue
        const bytes = Buffer.from(await pres.arrayBuffer())
        fs.mkdirSync(stagingDir, { recursive: true })
        fs.writeFileSync(target, bytes)
        blobBytesRestaged += bytes.length
        noteMirroredBlobPart(b.id, { messageId: part.messageId, fileId: part.fileId, fileName: part.fileName, bytes: bytes.length })
      } catch {
        /* best-effort per blob */
      }
    }
  }

  // Rebuild the maintained live counters from the applied table state —
  // snapshot imports/boot restores would otherwise leave them empty.
  try {
    await db.execute({
      sql: `INSERT INTO v5_counters (owner, name, value, updated_at)
            SELECT owner, 'kv:' || collection || ':live', COUNT(*), ? FROM v5_kv WHERE deleted_at IS NULL GROUP BY owner, collection
            ON CONFLICT(owner, name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      args: [Date.now()],
    })
  } catch {
    /* counters are advisory */
  }

  // The apply wrote rows straight to SQLite — drop the per-key hot cache so
  // reads observe restored data immediately (never serve a cached miss).
  clearKvCache()

  state().lastAppliedTs = payload.ts
  step('done', { kv: appliedKv, blobs: appliedBlobs, accounts: appliedAccounts })
  return { ok: true, snapshotTs: payload.ts, via, applied: { kv: appliedKv, blobs: appliedBlobs, accounts: appliedAccounts, blobBytesRestaged } }
}

// ─── Boot auto-restore ───────────────────────────────────────────────────────

interface BootGlobal {
  __v5BootRestore?: Promise<RestoreResult | { ok: boolean; skipped?: string }>
}

/**
 * Cold-boot recovery: if the SQLite store is EMPTY and a Telegram snapshot
 * exists, rebuild automatically. File mode always (ephemeral disks);
 * remote mode only with V5_AUTO_RESTORE=true (a wiped remote DB is usually
 * deliberate, so it is opt-in there).
 */
export async function bootRestoreIfEmpty(): Promise<RestoreResult | { ok: boolean; skipped?: string }> {
  console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.boot-restore', level: 'info', step: 'start' }))
  const bg = globalThis as unknown as BootGlobal
  if (bg.__v5BootRestore) return bg.__v5BootRestore
  const run = (async (): Promise<RestoreResult | { ok: boolean; skipped?: string }> => {
    try {
      if (!isV5BackupConfigured()) return { ok: true, skipped: 'backup-not-configured' }
      if (!isFileMode() && process.env.V5_AUTO_RESTORE !== 'true') return { ok: true, skipped: 'remote-mode-opt-in' }
      const db = await v5db()
      console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.boot-restore', level: 'info', step: 'db-ready' }))
      const rs = await db.execute('SELECT COUNT(*) AS n FROM v5_kv WHERE deleted_at IS NULL')
      const live = Number(rs.rows[0]?.n ?? 0)
      console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.boot-restore', level: 'info', step: 'counted', live }))
      if (live > 0) return { ok: true, skipped: 'non-empty' }
      console.log(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.boot-restore', level: 'info', step: 'calling-restore' }))
      const restored = await restoreV5FromTelegram()
      if (!restored.ok) {
        console.warn(
          JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.boot-restore', level: 'warn', reason: restored.reason }),
        )
      } else {
        console.log(
          JSON.stringify({
            t: new Date().toISOString(),
            operation: 'v5.backup.boot-restore',
            level: 'info',
            applied: restored.applied,
            snapshotTs: restored.snapshotTs,
          }),
        )
      }
      return restored
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.boot-restore', level: 'warn', error: message }))
      return { ok: false, reason: message }
    }
  })()
  bg.__v5BootRestore = run
  return run
}

/** Awaited by the request handler so the first request after a cold boot sees restored data. */
export function awaitBootRestore(): Promise<unknown> {
  const bg = globalThis as unknown as BootGlobal
  return bg.__v5BootRestore ?? Promise.resolve()
}

/** SQL string literal escape (snapshot payload is trusted, but never trust). */
function sqlEscape(s: string): string {
  return s.replace(/'/g, "''")
}

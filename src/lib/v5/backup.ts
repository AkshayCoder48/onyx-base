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

import { gunzipSync, gzipSync } from 'node:zlib'
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

/** Pinned-index userId under which the V5 snapshot document is registered. */
export const V5_SNAPSHOT_ACCOUNT = '__v5s__'

/** Bot-bio marker for the fallback snapshot pointer (setMyDescription). */
const BIO_MARKER = 'ONYXBASE_V5_SNAPSHOT'

/** Upload a fresh snapshot after this many mirrored writes (queue idle). */
const SNAPSHOT_EVERY_WRITES = 10

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
}

export interface SnapshotStatus {
  enabled: boolean
  lastSnapshotAt: number | null
  lastSnapshotKv: number | null
  writesSinceSnapshot: number
  snapshotEveryWrites: number
}

interface BackupGlobal {
  __v5Backup?: {
    lastSnapshotAt: number | null
    lastSnapshotKv: number | null
    writesSince: number
    busy: boolean
  }
  /** blobId → latest mirrored part (captured by mirror.ts on send success). */
  __v5BlobParts?: Map<string, { messageId: number; fileId: string; fileName: string; bytes: number }>
}

const g = globalThis as unknown as BackupGlobal

function state() {
  g.__v5Backup ??= { lastSnapshotAt: null, lastSnapshotKv: null, writesSince: 0, busy: false }
  return g.__v5Backup
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

interface SnapshotPointer {
  f: string
  m: number
  ts?: number
}

async function botApi(method: string, body: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; description?: string }> {
  const token = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!token) return { ok: false, description: 'no bot token' }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    return (await res.json()) as { ok: boolean; result?: unknown; description?: string }
  } catch {
    return { ok: false, description: 'network error' }
  }
}

/** Write the snapshot pointer into the bot's own description (bio). */
async function setBioPointer(p: SnapshotPointer): Promise<boolean> {
  const description = `${BIO_MARKER} {"f":"${p.f}","m":${p.m},"ts":${p.ts ?? 0}}`.slice(0, 512)
  const r = await botApi('setMyDescription', { description })
  return r.ok
}

/** Read the snapshot pointer from the bot's description (fallback path). */
async function getBioPointer(): Promise<SnapshotPointer | null> {
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
async function getIndexPointer(): Promise<SnapshotPointer | null> {
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
  if (s.busy) return { ok: false, reason: 'snapshot-in-progress' }
  s.busy = true
  try {
    const db = await v5db()
    const kvRows = await db.execute(
      'SELECT owner, collection, key, value, size, created_at, updated_at, deleted_at FROM v5_kv',
    )
    const blobRows = await db.execute(
      'SELECT id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at FROM v5_blobs',
    )
    const acctRows = await db.execute(
      'SELECT id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, idem_register, created_at, updated_at FROM v5_accounts',
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
      }
      const p = parts?.get(row.id)
      if (p && row.status === 'ready') row.parts = [p]
      return row
    })

    const payload: SnapshotPayloadV1 = {
      v: 1,
      kind: 'v5-snapshot',
      ts: Date.now(),
      kv: kvRows.rows.map((r) => ({
        o: String(r.owner),
        c: String(r.collection),
        k: String(r.key),
        v: String(r.value),
        s: Number(r.size ?? 0),
        ca: Number(r.created_at ?? 0),
        ua: Number(r.updated_at ?? 0),
        d: r.deleted_at === null ? null : Number(r.deleted_at),
      })),
      blobs,
      accounts: acctRows.rows.map((r) => ({
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
    }

    const gz = gzipSync(Buffer.from(JSON.stringify(payload), 'utf-8'))
    const sent = await sendDocumentFile({
      file: new Blob([new Uint8Array(gz)]),
      fileName: `v5-snapshot-${payload.ts}.json.gz`,
      mimeType: 'application/gzip',
      caption: `${CAPTION_MARKER}|ts=${payload.ts}|kv=${payload.kv.length}|blobs=${payload.blobs.length}|reason=${reason}`,
    })
    if (!sent.ok || !sent.document) {
      return { ok: false, reason: (!sent.ok && sent.error) || 'sendDocument failed' }
    }

    // ── Pointer layer 1: minimal foreign entry in the pinned V4 index.
    // The shared pin is nearly full (3977/4096 chars in this chat), so the
    // entry carries ONLY {f: fileId, m: messageId} (~110 chars). V4's sync
    // merges foreign accounts into the index, so the entry survives V4
    // activity; V4 never reads fields of accounts it does not own.
    const iso = new Date(payload.ts).toISOString()
    const pointer: SnapshotPointer = { f: sent.document.fileId, m: sent.document.messageId, ts: payload.ts }
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
    let bio = false
    try {
      bio = await setBioPointer(pointer)
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

    s.lastSnapshotAt = payload.ts
    s.lastSnapshotKv = payload.kv.length
    s.writesSince = 0
    return {
      ok: true,
      ts: payload.ts,
      kv: payload.kv.length,
      blobs: payload.blobs.length,
      accounts: payload.accounts.length,
      bytes: gz.length,
      messageId: sent.document.messageId,
      fileId: sent.document.fileId,
      indexed,
      bio,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, reason: message }
  } finally {
    s.busy = false
  }
}

/** Called by the mirror drain when the queue goes idle. */
export async function maybeSnapshotOnIdle(): Promise<void> {
  const s = state()
  if (s.writesSince >= SNAPSHOT_EVERY_WRITES) {
    s.writesSince = 0
    const res = await uploadV5Snapshot('auto')
    if (!res.ok) {
      console.warn(
        JSON.stringify({ t: new Date().toISOString(), operation: 'v5.backup.auto-snapshot', level: 'warn', reason: res.reason }),
      )
    }
  }
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
  const res = await fetch(dl.url)
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
        `INSERT INTO v5_accounts (id, owner_key, api_key_hash, email, email_lower, password_hash, name, role, idem_register, created_at, updated_at) VALUES (` +
        `'${sqlEscape(a.id)}', '${sqlEscape(a.owner_key)}', '${sqlEscape(a.api_key_hash)}', ${a.email === null ? 'NULL' : `'${sqlEscape(a.email)}'`}, ` +
        `${a.email_lower === null ? 'NULL' : `'${sqlEscape(a.email_lower)}'`}, ${a.password_hash === null ? 'NULL' : `'${sqlEscape(a.password_hash)}'`}, ` +
        `${a.name === null ? 'NULL' : `'${sqlEscape(a.name)}'`}, '${sqlEscape(a.role)}', ${a.idem_register === null ? 'NULL' : `'${sqlEscape(a.idem_register)}'`}, ` +
        `${a.created_at}, ${a.updated_at}) ON CONFLICT (id) DO NOTHING`,
    )
    for (let i = 0; i < stmts.length; i += BATCH) {
      const r = await db.batch(stmts.slice(i, i + BATCH).map((s) => ({ sql: s, args: [] })), 'write')
      appliedAccounts += r.filter((x) => Number(x.rowsAffected ?? 0) > 0).length
    }
  }

  let appliedBlobs = 0
  let blobBytesRestaged = 0
  if (Array.isArray(payload.blobs) && payload.blobs.length) {
    const stmts = payload.blobs.map(
      (b) =>
        `INSERT INTO v5_blobs (id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at) VALUES (` +
        `'${sqlEscape(b.id)}', '${sqlEscape(b.owner)}', ${b.filename === null ? 'NULL' : `'${sqlEscape(b.filename)}'`}, ` +
        `${b.mime === null ? 'NULL' : `'${sqlEscape(b.mime)}'`}, ${b.size}, ${b.checksum === null ? 'NULL' : `'${sqlEscape(b.checksum)}'`}, ` +
        `'${sqlEscape(b.status)}', ${b.storage_key === null ? 'NULL' : `'${sqlEscape(b.storage_key)}'`}, ${b.chunks}, ${b.is_public}, ` +
        `${b.created_at}, ${b.updated_at}) ON CONFLICT (id) DO NOTHING`,
    )
    for (let i = 0; i < stmts.length; i += BATCH) {
      const r = await db.batch(stmts.slice(i, i + BATCH).map((s) => ({ sql: s, args: [] })), 'write')
      appliedBlobs += r.filter((x) => Number(x.rowsAffected ?? 0) > 0).length
    }
    // Byte-level recovery: re-stage ready blobs whose parts are referenced.
    for (const b of payload.blobs) {
      if (b.status !== 'ready' || !b.parts?.length) continue
      try {
        const stagingDir = process.env.V5_BLOB_STAGING_DIR || path.join(process.cwd(), '.data', 'v5-blobs')
        const target = path.join(stagingDir, b.id)
        if (fs.existsSync(target)) continue // local copy already present
        const part = b.parts[0]
        const pdl = await getFileDownloadUrl(part.fileId)
        if (!pdl) continue
        const pres = await fetch(pdl.url)
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

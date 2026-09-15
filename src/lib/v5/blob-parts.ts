/**
 * OnyxBase V5 — PARTS-MODE blob storage (permanent Telegram-backed files).
 *
 * The single-PUT blob flow (blobs.ts) stages bytes on the INSTANCE'S local
 * disk — fine for dev/self-host, but on serverless (Vercel) each instance has
 * a private, ephemeral volume, so a blob finalized on instance A cannot be
 * served by instance B and dies with the instance. Parts mode fixes that:
 *
 *   init      POST /api/v5/blobs { chunked: true, size, checksum? }
 *             → v5_blobs row (mode marker) + durable KV manifest skeleton.
 *   part PUT  PUT /api/v5/blobs/:id/parts/:index   (raw body ≤ V5_PART_SIZE)
 *             → the part is sent to Telegram AS A DOCUMENT immediately
 *               (multi-instance safe by construction — no shared staging),
 *               and a durable KV part record {fileId, messageId, bytes,
 *               checksum} is written (append-only key per index → no
 *               read-modify-write races across instances).
 *   status    GET /api/v5/blobs/:id → receivedChunks / missingChunks
 *             (KV prefix scan) → the client resumes ONLY missing parts.
 *   finalize  POST /api/v5/blobs/:id {action:'finalize', parts:[…refs]}
 *             → every client-supplied ref is verified via getFile (Telegram's
 *               own file_size must match the expected chunk bytes — forged or
 *               stale refs fail here), then the durable manifest is written
 *               and the blob becomes READY. Dedup: same owner + same
 *               full-file checksum → the existing ready blob is returned
 *               (alreadyProcessed: true) instead of a duplicate.
 *   serve     GET /f/:id (public) — streams the parts in order from Telegram
 *             via cached getFile URLs; supports Range/206, HEAD, ETag.
 *
 * Why ~4 MiB parts and not the 19 MiB the PRD sketches: every request that
 * transits a Vercel function is hard-capped at ~4.5 MB (platform limit), so a
 * single HTTP request can never carry a 19 MiB chunk. 4 MiB parts ride BOTH
 * the transport limit AND Telegram's cloud Bot API caps (sendDocument ≤ 50 MB
 * up, getFile ≤ 20 MB down) with room to spare. Chunking stays invisible to
 * the user either way — the API negotiates chunkSize at init and the client
 * uses whatever the server returns. Self-hosted deployments MAY raise it via
 * V5_PART_SIZE.
 *
 * Durability layers (all Telegram-snapshot covered):
 *   - KV `part:{blobId}:{idx}`  → per-part Telegram refs (resume).
 *   - KV `blob:{blobId}`        → final manifest (owner-scoped, belt+braces).
 *   - v5_blobs.parts_json       → manifest copy on the row (fast local serve,
 *                                 restored cross-instance via the full-state
 *                                 snapshot).
 *   - KV `sum:{checksum}`       → owner dedup index.
 */

import { createHash, randomBytes } from 'node:crypto'
import { v5db, nowMs, num } from './db'
import { kvSet, kvGet, kvPage } from './kv'
import { emitEvent } from './events'
import { V5Error } from './errors'
import { getBlob, type V5Blob, type BlobStatus } from './blobs'
import {
  sendDocumentFile,
  getFileDownloadUrl,
  type SendDocumentResult,
} from '@/lib/telegram'

// ─── Tunables ────────────────────────────────────────────────────────────────

/**
 * Transport + storage part size. Default 4 MiB: safely under Vercel's ~4.5 MB
 * request-body cap AND Telegram cloud Bot API limits in both directions.
 */
export const V5_PART_SIZE = (() => {
  const raw = Number(process.env.V5_PART_SIZE || 0)
  if (Number.isFinite(raw) && raw >= 256 * 1024 && raw <= 19 * 1024 * 1024) {
    return Math.floor(raw)
  }
  return 4 * 1024 * 1024
})()

/** Max parts per blob (512 × 4 MiB = 2 GiB). */
export const V5_PARTS_MAX = 512

/** Hard ceiling on one parts-mode blob. */
export const V5_PARTS_MAX_TOTAL = V5_PART_SIZE * V5_PARTS_MAX

/** KV collection holding manifests, part records and the dedup index. */
const BLOBMETA_COLLECTION = 'v5_blobmeta'

// ─── Manifest / part record shapes ───────────────────────────────────────────

export interface BlobPartRef {
  index: number
  /** Telegram bot-scoped file_id of the stored document. */
  fileId: string
  /** Telegram message id in the storage chat (for cleanup). */
  messageId?: number
  bytes: number
  /** sha256 of this part's bytes, computed at receipt. */
  checksum?: string
}

export interface BlobManifest {
  v: 1
  mode: 'parts'
  blobId: string
  owner: string
  filename: string | null
  mimeType: string | null
  size: number
  /** Full-file sha256 (client-computed, optional). */
  checksum: string | null
  status: BlobStatus
  isPublic: boolean
  chunkSize: number
  totalChunks: number
  /** Present once READY. */
  parts?: BlobPartRef[]
  createdAt: number
  updatedAt: number
}

interface PartRecord {
  fileId: string
  messageId?: number
  bytes: number
  checksum?: string
  at: number
}

// ─── KV key helpers ──────────────────────────────────────────────────────────

function manifestKey(blobId: string): string {
  return `blob:${blobId}`
}

function partKey(blobId: string, index: number): string {
  return `part:${blobId}:${String(index).padStart(6, '0')}`
}

function partPrefix(blobId: string): string {
  return `part:${blobId}:`
}

function dedupKey(checksum: string): string {
  return `sum:${checksum}`
}

// ─── Row helpers ─────────────────────────────────────────────────────────────

function validBlobId(id: string): boolean {
  return /^blb_[a-z0-9]+$/.test(id)
}

async function patchRow(blobId: string, patch: Record<string, unknown>): Promise<void> {
  const db = await v5db()
  const cols = Object.keys(patch)
  if (cols.length === 0) return
  const sql = `UPDATE v5_blobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  const args: Array<string | number | null> = [
    ...cols.map((c) => {
      const v = patch[c]
      if (v === undefined) return null
      if (typeof v === 'object' && v !== null) return JSON.stringify(v)
      return v as string | number | null
    }),
    nowMs(),
    blobId,
  ]
  await db.execute({ sql, args })
}

/** Manifest from the durable KV layer (owner-scoped). */
async function getManifest(owner: string, blobId: string): Promise<BlobManifest | null> {
  const row = await kvGet(owner, manifestKey(blobId), BLOBMETA_COLLECTION)
  const m = row?.value as BlobManifest | undefined
  return m && m.v === 1 && m.mode === 'parts' && m.blobId === blobId ? m : null
}

async function putManifest(m: BlobManifest): Promise<void> {
  await kvSet(m.owner, manifestKey(m.blobId), m as unknown as Record<string, unknown>, BLOBMETA_COLLECTION)
}

// ─── Telegram helpers ────────────────────────────────────────────────────────

/** Send a part document, retrying throttles with Telegram's own retry_after. */
async function sendPartWithRetry(
  payload: { file: Blob; fileName: string; mimeType: string; caption?: string },
  attempts = 4,
): Promise<SendDocumentResult> {
  let last: SendDocumentResult = { ok: false, error: 'not attempted' }
  for (let i = 0; i < attempts; i++) {
    last = await sendDocumentFile(payload)
    if (last.ok) return last
    const err = last.error || ''
    // Retry ONLY on throttle/transport classes; crisp rejections fail fast.
    if (!/too many requests|429|flood|network error|timeout|temporar/i.test(err)) return last
    const m = /retry after (\d+)/i.exec(err)
    const waitMs = m ? Math.min(parseInt(m[1], 10) || 3, 15) * 1000 : 2500 + i * 1500
    await new Promise((r) => setTimeout(r, waitMs))
  }
  return last
}

// ─── Init ────────────────────────────────────────────────────────────────────

export interface CreatePartsResult {
  blobId: string
  chunkSize: number
  totalChunks: number
  status: BlobStatus
}

export async function createPartsBlob(
  owner: string,
  meta: { filename?: string; mimeType?: string; size: number; checksum?: string; isPublic?: boolean }
): Promise<CreatePartsResult> {
  const size = Math.floor(meta.size)
  if (!Number.isFinite(size) || size <= 0) {
    throw new V5Error('VALIDATION_ERROR', 'size must be a positive number of bytes.')
  }
  if (size > V5_PARTS_MAX_TOTAL) {
    throw new V5Error(
      'PAYLOAD_TOO_LARGE',
      `File is ${(size / 1024 / 1024).toFixed(0)} MB — the parts-storage ceiling is ${(V5_PARTS_MAX_TOTAL / 1024 / 1024 / 1024).toFixed(0)} GB.`,
    )
  }
  const totalChunks = Math.ceil(size / V5_PART_SIZE)
  if (totalChunks > V5_PARTS_MAX) {
    throw new V5Error('PAYLOAD_TOO_LARGE', `File needs ${totalChunks} parts — the maximum is ${V5_PARTS_MAX}.`)
  }
  const blobId = `blb_${randomBytes(12).toString('hex')}`
  const now = nowMs()
  const manifest: BlobManifest = {
    v: 1,
    mode: 'parts',
    blobId,
    owner,
    filename: meta.filename?.slice(0, 255) || null,
    mimeType: meta.mimeType?.slice(0, 127) || null,
    size,
    checksum: meta.checksum ? String(meta.checksum).slice(0, 128) : null,
    status: 'created',
    isPublic: meta.isPublic !== false,
    chunkSize: V5_PART_SIZE,
    totalChunks,
    createdAt: now,
    updatedAt: now,
  }
  // Row first (fast local index), manifest second (durable). The row's
  // parts_json stays NULL until finalize — its absence + mode marker in
  // storage_key ('parts') identifies parts-mode rows.
  const db = await v5db()
  await db.execute({
    sql: `INSERT INTO v5_blobs (id, owner, filename, mime, size, checksum, status, storage_key, chunks, is_public, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'created', 'parts', ?, ?, ?, ?)`,
    args: [
      blobId,
      owner,
      manifest.filename,
      manifest.mimeType,
      size,
      manifest.checksum,
      totalChunks,
      manifest.isPublic ? 1 : 0,
      now,
      now,
    ],
  })
  await putManifest(manifest)
  return { blobId, chunkSize: V5_PART_SIZE, totalChunks, status: 'created' }
}

/** Expected byte length of part `index` (all but the last are exactly chunkSize). */
export function partExpectedBytes(size: number, chunkSize: number, totalChunks: number, index: number): number {
  return index === totalChunks - 1 ? size - chunkSize * (totalChunks - 1) : chunkSize
}

// ─── Manifest resolution (row → KV → freshness probe) ────────────────────────

/**
 * Resolve the parts manifest for an owner-scoped call. Order:
 *   1. durable KV manifest (fresh via miss-probe),
 *   2. v5_blobs row reconstruction (snapshot-restored rows carry parts_json).
 */
async function resolveManifest(owner: string, blobId: string): Promise<BlobManifest> {
  if (!validBlobId(blobId)) throw new V5Error('NOT_FOUND', 'Blob not found.', 404)
  let manifest = await getManifest(owner, blobId)
  if (manifest) return manifest
  const row = await getBlob(blobId)
  if (row && row.owner === owner && row.storageKey === 'parts') {
    const partsJson = await readRowParts(blobId)
    return rowToManifest(row, partsJson)
  }
  throw new V5Error('NOT_FOUND', 'Blob not found.', 404)
}

async function readRowParts(blobId: string): Promise<BlobPartRef[] | null> {
  const db = await v5db()
  const rs = await db.execute({ sql: `SELECT parts_json FROM v5_blobs WHERE id = ? LIMIT 1`, args: [blobId] })
  const raw = rs.rows.length > 0 ? String((rs.rows[0] as Record<string, unknown>).parts_json ?? '') : ''
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as BlobPartRef[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function rowToManifest(row: V5Blob, parts: BlobPartRef[] | null): BlobManifest {
  return {
    v: 1,
    mode: 'parts',
    blobId: row.blobId,
    owner: row.owner,
    filename: row.filename,
    mimeType: row.mimeType,
    size: row.size,
    checksum: row.checksum,
    status: row.status,
    isPublic: row.isPublic,
    chunkSize: V5_PART_SIZE,
    totalChunks: Math.max(1, Math.ceil(row.size / V5_PART_SIZE)),
    parts: parts ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

// ─── Part upload ─────────────────────────────────────────────────────────────

export interface PutPartResult {
  index: number
  fileId: string
  messageId: number | null
  bytes: number
  checksum: string
  alreadyStored: boolean
  received: number
}

/**
 * Ingest one part: raw body bytes → Telegram document → durable part record.
 * Idempotent: a part whose record already exists with the expected byte count
 * is acknowledged WITHOUT re-sending (a retried request never duplicates).
 */
export async function putBlobPart(
  owner: string,
  blobId: string,
  index: number,
  body: ReadableStream<Uint8Array> | null
): Promise<PutPartResult> {
  const manifest = await resolveManifest(owner, blobId)
  if (manifest.status === 'ready' || manifest.status === 'finalizing') {
    throw new V5Error('BLOB_NOT_READY', `Blob is ${manifest.status} and cannot receive more parts.`)
  }
  if (manifest.status === 'cancelled' || manifest.status === 'failed') {
    throw new V5Error('BLOB_NOT_READY', `Blob is ${manifest.status}.`)
  }
  if (!Number.isInteger(index) || index < 0 || index >= manifest.totalChunks) {
    throw new V5Error('VALIDATION_ERROR', `Part index must be 0..${manifest.totalChunks - 1}.`)
  }
  if (!body) throw new V5Error('VALIDATION_ERROR', 'Missing request body.')

  const expected = partExpectedBytes(manifest.size, manifest.chunkSize, manifest.totalChunks, index)

  // Idempotent replay: the part already landed (size matches) → acknowledge.
  const existingRow = await kvGet(owner, partKey(blobId, index), BLOBMETA_COLLECTION)
  const existing = existingRow?.value as PartRecord | undefined
  if (existing && typeof existing.fileId === 'string' && existing.bytes === expected) {
    return {
      index,
      fileId: existing.fileId,
      messageId: existing.messageId ?? null,
      bytes: existing.bytes,
      checksum: existing.checksum || '',
      alreadyStored: true,
      received: await countParts(owner, blobId, manifest.totalChunks),
    }
  }

  // Buffer the part (≤ ~4 MiB + safety margin) and hash it.
  const buf = Buffer.from(await new Response(body).arrayBuffer())
  if (buf.byteLength > V5_PART_SIZE + 64 * 1024) {
    throw new V5Error('PAYLOAD_TOO_LARGE', `Part exceeds the ${V5_PART_SIZE} byte chunk size.`)
  }
  if (buf.byteLength !== expected) {
    throw new V5Error(
      'VALIDATION_ERROR',
      `Part ${index} must be exactly ${expected} bytes for this file (got ${buf.byteLength}).`,
    )
  }
  const checksum = createHash('sha256').update(buf).digest('hex')

  // Store the part AS a Telegram document — immediately permanent.
  const partName = `${blobId}.part${String(index).padStart(6, '0')}`
  const sent = await sendPartWithRetry({
    file: new Blob([new Uint8Array(buf)], { type: 'application/octet-stream' }),
    fileName: partName,
    mimeType: 'application/octet-stream',
    caption: `onyxbase-v5-part|${blobId}|${index}|${manifest.totalChunks}`,
  })
  if (!sent.ok) {
    throw new V5Error('STORAGE_UNAVAILABLE', `Storing part ${index} failed: ${sent.error || 'unknown error'}`)
  }
  if (!sent.document) {
    throw new V5Error('STORAGE_UNAVAILABLE', `Storing part ${index} failed: Telegram returned no document reference.`)
  }

  const record: PartRecord = {
    fileId: sent.document.fileId,
    messageId: sent.document.messageId,
    bytes: buf.byteLength,
    checksum,
    at: nowMs(),
  }
  await kvSet(owner, partKey(blobId, index), record as unknown as Record<string, unknown>, BLOBMETA_COLLECTION)

  // Best-effort row status refresh (the manifest in KV is authoritative).
  await patchRow(blobId, { status: 'uploading' }).catch(() => {})

  return {
    index,
    fileId: record.fileId,
    messageId: record.messageId ?? null,
    bytes: record.bytes,
    checksum,
    alreadyStored: false,
    received: await countParts(owner, blobId, manifest.totalChunks),
  }
}

/** Count durably-recorded parts (for the `received` hint). */
async function countParts(owner: string, blobId: string, totalChunks: number): Promise<number> {
  let received = 0
  let offset = 0
  for (let page = 0; page < 8; page++) {
    const p = await kvPage(owner, { collection: BLOBMETA_COLLECTION, prefix: partPrefix(blobId), limit: 1000, offset })
    received += p.items.length
    if (!p.hasMore) break
    offset += p.items.length
  }
  return Math.min(received, totalChunks)
}

// ─── Status / resume ─────────────────────────────────────────────────────────

export interface PartsStatusResult {
  blobId: string
  status: BlobStatus
  size: number
  chunkSize: number
  totalChunks: number
  receivedChunks: number[]
  missingChunks: number[]
  /**
   * Durable refs for every received part — the resume client forwards them
   * at finalize (client refs are the cross-instance bridge: the finalizing
   * instance may not yet have this instance's part records).
   */
  parts: Array<{ index: number; fileId: string; messageId?: number }>
  filename: string | null
  mimeType: string | null
  checksum: string | null
}

export async function getPartsStatus(owner: string, blobId: string): Promise<PartsStatusResult> {
  const manifest = await resolveManifest(owner, blobId)
  const have = new Map<number, { fileId: string; messageId?: number }>()
  let offset = 0
  for (let page = 0; page < 8; page++) {
    const p = await kvPage(owner, { collection: BLOBMETA_COLLECTION, prefix: partPrefix(blobId), limit: 1000, offset })
    for (const it of p.items) {
      const m = /\.(\d{6})$/.exec(it.key)
      if (!m) continue
      const idx = parseInt(m[1], 10)
      const rec = it.value as PartRecord | undefined
      if (rec && typeof rec.fileId === 'string' && rec.bytes === partExpectedBytes(manifest.size, manifest.chunkSize, manifest.totalChunks, idx)) {
        have.set(idx, { fileId: rec.fileId, messageId: rec.messageId })
      }
    }
    if (!p.hasMore) break
    offset += p.items.length
  }
  const receivedChunks: number[] = []
  const missingChunks: number[] = []
  for (let i = 0; i < manifest.totalChunks; i++) {
    ;(have.has(i) ? receivedChunks : missingChunks).push(i)
  }
  const parts = [...have.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, ref]) => ({ index, fileId: ref.fileId, messageId: ref.messageId }))
  return {
    blobId,
    status: manifest.status,
    size: manifest.size,
    chunkSize: manifest.chunkSize,
    totalChunks: manifest.totalChunks,
    receivedChunks,
    missingChunks,
    parts,
    filename: manifest.filename,
    mimeType: manifest.mimeType,
    checksum: manifest.checksum,
  }
}

// ─── Finalize ────────────────────────────────────────────────────────────────

export interface FinalizePartsResult {
  blobId: string
  status: 'ready'
  url: string
  alreadyProcessed?: boolean
  dedupOf?: string
  size: number
  checksum: string | null
  totalChunks: number
}

/**
 * Finalize a parts upload. `clientParts` are the refs the CLIENT collected
 * from part-PUT responses (freshest possible set — cross-instance KV may lag).
 * Every ref is verified against Telegram via getFile before the manifest is
 * committed: file_size must match the expected chunk bytes.
 */
export async function finalizePartsBlob(
  owner: string,
  blobId: string,
  clientParts: Array<{ index: number; fileId: string; messageId?: number }>
): Promise<FinalizePartsResult> {
  const manifest = await resolveManifest(owner, blobId)

  if (manifest.status === 'ready' && manifest.parts && manifest.parts.length > 0) {
    return {
      blobId,
      status: 'ready',
      url: `/f/${blobId}`,
      size: manifest.size,
      checksum: manifest.checksum,
      totalChunks: manifest.totalChunks,
    }
  }
  if (manifest.status === 'cancelled' || manifest.status === 'failed') {
    throw new V5Error('BLOB_NOT_READY', `Blob is ${manifest.status}.`)
  }

  if (!Array.isArray(clientParts) || clientParts.length !== manifest.totalChunks) {
    throw new V5Error(
      'VALIDATION_ERROR',
      `Expected exactly ${manifest.totalChunks} part references — got ${Array.isArray(clientParts) ? clientParts.length : 'none'}.`,
    )
  }

  // Index the client refs; fill any gap from the durable KV records.
  const byIndex = new Map<number, BlobPartRef>()
  for (const cp of clientParts) {
    if (!cp || typeof cp.index !== 'number' || typeof cp.fileId !== 'string' || !cp.fileId) {
      throw new V5Error('VALIDATION_ERROR', 'Each part reference needs { index, fileId }.')
    }
    byIndex.set(cp.index, { index: cp.index, fileId: cp.fileId, messageId: cp.messageId, bytes: 0 })
  }
  const kvRecords = new Map<number, PartRecord>()
  let offset = 0
  for (let page = 0; page < 8; page++) {
    const p = await kvPage(owner, { collection: BLOBMETA_COLLECTION, prefix: partPrefix(blobId), limit: 1000, offset })
    for (const it of p.items) {
      const m = /\.(\d{6})$/.exec(it.key)
      if (!m) continue
      const rec = it.value as PartRecord | undefined
      if (rec && typeof rec.fileId === 'string') kvRecords.set(parseInt(m[1], 10), rec)
    }
    if (!p.hasMore) break
    offset += p.items.length
  }

  const parts: BlobPartRef[] = []
  for (let i = 0; i < manifest.totalChunks; i++) {
    const expected = partExpectedBytes(manifest.size, manifest.chunkSize, manifest.totalChunks, i)
    const clientRef = byIndex.get(i)
    const kvRec = kvRecords.get(i)
    // Client refs win (freshest); KV records fill gaps and cross-check sizes.
    if (clientRef && kvRec && kvRec.fileId === clientRef.fileId && kvRec.bytes === expected) {
      parts.push({ index: i, fileId: kvRec.fileId, messageId: kvRec.messageId ?? clientRef.messageId, bytes: expected, checksum: kvRec.checksum })
    } else if (clientRef) {
      parts.push({ index: i, fileId: clientRef.fileId, messageId: clientRef.messageId ?? undefined, bytes: expected })
    } else if (kvRec && kvRec.bytes === expected) {
      parts.push({ index: i, fileId: kvRec.fileId, messageId: kvRec.messageId, bytes: expected, checksum: kvRec.checksum })
    } else {
      throw new V5Error(
        'BLOB_NOT_READY',
        `Part ${i} of ${manifest.totalChunks} is missing — upload it before finalizing.`,
        { missingChunks: [i] },
      )
    }
  }

  // Verify EVERY part against Telegram (parallel, bounded): the bot-scoped
  // file_id must resolve and Telegram's own file_size must match.
  const VERIFY_CONCURRENCY = 8
  for (let start = 0; start < parts.length; start += VERIFY_CONCURRENCY) {
    const slice = parts.slice(start, start + VERIFY_CONCURRENCY)
    const results = await Promise.all(
      slice.map(async (p) => ({ p, r: await getFileDownloadUrl(p.fileId) }))
    )
    for (const { p, r } of results) {
      if (!r) {
        throw new V5Error(
          'BLOB_NOT_READY',
          `Part ${p.index} could not be verified on Telegram (getFile failed) — re-upload it and retry.`,
          { missingChunks: [p.index] },
        )
      }
      if (r.fileSize !== null && r.fileSize !== p.bytes) {
        throw new V5Error(
          'BLOB_NOT_READY',
          `Part ${p.index} is ${r.fileSize} bytes on Telegram but ${p.bytes} were declared — re-upload it and retry.`,
          { missingChunks: [p.index] },
        )
      }
    }
  }

  // Dedup: same owner + same full-file checksum + an existing READY blob →
  // hand back the existing object instead of a duplicate.
  if (manifest.checksum) {
    const dedupRow = await kvGet(owner, dedupKey(manifest.checksum), BLOBMETA_COLLECTION)
    const existingBlobId = dedupRow?.value as string | undefined
    if (typeof existingBlobId === 'string' && existingBlobId !== blobId) {
      const existing = await getManifest(owner, existingBlobId)
      if (existing && existing.status === 'ready' && existing.parts && existing.parts.length > 0) {
        // The staged duplicate's Telegram docs are no longer needed.
        void cancelPartsBlob(owner, blobId).catch(() => {})
        return {
          blobId: existingBlobId,
          status: 'ready',
          url: `/f/${existingBlobId}`,
          alreadyProcessed: true,
          dedupOf: existingBlobId,
          size: existing.size,
          checksum: existing.checksum,
          totalChunks: existing.totalChunks,
        }
      }
    }
  }

  // Commit: durable manifest + row (parts_json for fast/cross-instance serve)
  // + dedup index.
  const finalized: BlobManifest = {
    ...manifest,
    status: 'ready',
    parts,
    updatedAt: nowMs(),
  }
  await putManifest(finalized)
  await patchRow(blobId, {
    status: 'ready',
    error: null,
    checksum: finalized.checksum ?? null,
    parts_json: parts,
  })
  if (finalized.checksum) {
    await kvSet(owner, dedupKey(finalized.checksum), blobId, BLOBMETA_COLLECTION)
  }
  await emitEvent(owner, 'BLOB_STATUS', blobId, { status: 'ready', size: finalized.size, parts: parts.length })

  // Durability: land the manifest in a Telegram snapshot promptly (durable
  // background work — never blocks the response).
  try {
    const { durable } = await import('./durable')
    durable(
      (async () => {
        const { maybeSnapshotOnIdle } = await import('./backup')
        await maybeSnapshotOnIdle()
      })(),
    )
  } catch {
    /* snapshot optional */
  }

  return {
    blobId,
    status: 'ready',
    url: `/f/${blobId}`,
    size: finalized.size,
    checksum: finalized.checksum,
    totalChunks: finalized.totalChunks,
  }
}

// ─── Cancel ──────────────────────────────────────────────────────────────────

/**
 * Cancel a parts upload: mark cancelled and delete the staged Telegram
 * documents (best-effort — refs come from the durable part records).
 */
export async function cancelPartsBlob(owner: string, blobId: string): Promise<{ blobId: string; status: BlobStatus; deletedDocs: number }> {
  const manifest = await resolveManifest(owner, blobId)
  if (manifest.status === 'ready') {
    throw new V5Error('BLOB_NOT_READY', 'A ready blob cannot be cancelled.')
  }
  let deletedDocs = 0
  const records: Array<{ index: number; rec: PartRecord }> = []
  let offset = 0
  for (let page = 0; page < 8; page++) {
    const p = await kvPage(owner, { collection: BLOBMETA_COLLECTION, prefix: partPrefix(blobId), limit: 1000, offset })
    for (const it of p.items) {
      const m = /\.(\d{6})$/.exec(it.key)
      const rec = it.value as PartRecord | undefined
      if (m && rec) records.push({ index: parseInt(m[1], 10), rec })
    }
    if (!p.hasMore) break
    offset += p.items.length
  }
  for (const { rec } of records) {
    if (typeof rec.messageId !== 'number') continue
    const { deleteKvMessage } = await import('@/lib/telegram')
    const ok = await deleteKvMessage(rec.messageId).catch(() => false)
    if (ok) deletedDocs++
  }
  await putManifest({ ...manifest, status: 'cancelled', updatedAt: nowMs() })
  await patchRow(blobId, { status: 'cancelled' }).catch(() => {})
  await emitEvent(owner, 'BLOB_STATUS', blobId, { status: 'cancelled' })
  return { blobId, status: 'cancelled', deletedDocs }
}

// ─── Serving (public /f/:id) ─────────────────────────────────────────────────

/**
 * Resolve a blob for PUBLIC serving. Row first (fast, snapshot-restored),
 * then the durable KV manifest when the row is missing on this instance.
 * Returns null when the id is unknown (→ 404) — never throws.
 */
export async function loadBlobForServe(blobId: string): Promise<BlobManifest | null> {
  if (!validBlobId(blobId)) return null
  const row = await getBlob(blobId)
  if (row && row.storageKey === 'parts') {
    const parts = await readRowParts(blobId)
    if (row.status === 'ready') {
      if (parts && parts.length > 0) return rowToManifest(row, parts)
      // Row says ready but parts_json is missing (old snapshot?) → try the
      // durable manifest via the owner from the row.
      const m = await getManifest(row.owner, blobId)
      if (m && m.status === 'ready' && m.parts) return m
    }
    return null
  }
  return null
}

/** True when the blob id exists as a parts-mode blob still being uploaded. */
export async function isPartsBlobIncomplete(blobId: string): Promise<boolean> {
  const row = await getBlob(blobId)
  return Boolean(row && row.storageKey === 'parts' && row.status !== 'ready')
}

// ── Per-instance part byte cache (bounded LRU) ───────────────────────────────
// Video seeking issues several small Range requests inside the same part —
// a tiny hot cache keeps those instant.

interface CachedPart {
  buf: Buffer
  at: number
}
const globalForParts = globalThis as unknown as { __v5PartCache?: Map<string, CachedPart> }
const partCache: Map<string, CachedPart> = (globalForParts.__v5PartCache ??= new Map())
const PART_CACHE_MAX_BYTES = 48 * 1024 * 1024
const PART_CACHE_TTL_MS = 10 * 60 * 1000

function cacheGet(fileId: string): Buffer | null {
  const hit = partCache.get(fileId)
  if (!hit) return null
  if (Date.now() - hit.at > PART_CACHE_TTL_MS) {
    partCache.delete(fileId)
    return null
  }
  return hit.buf
}

function cachePut(fileId: string, buf: Buffer): void {
  partCache.set(fileId, { buf, at: Date.now() })
  if (partCache.size > 16) {
    // Evict the oldest entries until we are back under budget.
    let total = 0
    for (const c of partCache.values()) total += c.buf.byteLength
    const sorted = [...partCache.entries()].sort((a, b) => a[1].at - b[1].at)
    for (const [k, c] of sorted) {
      if (total <= PART_CACHE_MAX_BYTES && partCache.size <= 12) break
      total -= c.buf.byteLength
      partCache.delete(k)
    }
  }
}

async function fetchPart(fileId: string): Promise<Buffer | null> {
  const cached = cacheGet(fileId)
  if (cached) return cached
  const resolved = await getFileDownloadUrl(fileId)
  if (!resolved) return null
  const res = await fetch(resolved.url).catch(() => null)
  if (!res || !res.ok) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.byteLength === 0) return null
  cachePut(fileId, buf)
  return buf
}

export interface ServePartsOptions {
  rangeHeader: string | null
  ifNoneMatch: string | null
  filename: string
  mimeType: string
  etag: string | null
  isPublic: boolean
}

/**
 * Serve the logical file from its Telegram parts. Supports:
 *   - full GET  → 200, Content-Length, streamed part-by-part
 *   - Range     → 206 + Content-Range (single range spec, per RFC 7233)
 *   - HEAD semantics are handled by the caller via headersOnly
 */
export async function serveBlobParts(
  manifest: BlobManifest,
  opts: ServePartsOptions
): Promise<Response> {
  const parts = manifest.parts || []
  if (parts.length === 0) {
    return new Response('File contents are not available.', { status: 502, headers: { 'content-type': 'text/plain' } })
  }

  const headers = new Headers()
  const safeName = encodeURIComponent(opts.filename).replace(/'/g, '%27')
  headers.set('Content-Type', opts.mimeType || 'application/octet-stream')
  headers.set('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${safeName}`)
  headers.set('Accept-Ranges', 'bytes')
  headers.set('X-Content-Type-Options', 'nosniff')
  if (opts.etag) headers.set('ETag', `"${opts.etag}"`)
  headers.set('Cache-Control', opts.isPublic ? 'public, max-age=300' : 'private, no-store')
  headers.set('X-File-Name', opts.filename)

  if (opts.ifNoneMatch && opts.etag && opts.ifNoneMatch.replace(/"/g, '') === opts.etag) {
    return new Response(null, { status: 304, headers })
  }

  // Parse a single-range Range header (bytes=a-b | bytes=a- | bytes=-suffix).
  let start = 0
  let end = manifest.size - 1
  let partial = false
  if (opts.rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)\s*(?:,|$)/.exec(opts.rangeHeader.trim())
    if (m && (m[1] !== '' || m[2] !== '')) {
      if (m[1] === '') {
        // suffix range: last N bytes
        const suffix = Math.min(parseInt(m[2], 10) || 0, manifest.size)
        if (suffix <= 0) {
          headers.set('Content-Range', `bytes */${manifest.size}`)
          return new Response(null, { status: 416, headers })
        }
        start = manifest.size - suffix
        end = manifest.size - 1
      } else {
        start = parseInt(m[1], 10)
        end = m[2] === '' ? manifest.size - 1 : Math.min(parseInt(m[2], 10), manifest.size - 1)
      }
      if (start > end || start >= manifest.size) {
        headers.set('Content-Range', `bytes */${manifest.size}`)
        return new Response(null, { status: 416, headers })
      }
      partial = true
    }
  }
  const length = end - start + 1
  headers.set('Content-Length', String(length))
  if (partial) {
    headers.set('Content-Range', `bytes ${start}-${end}/${manifest.size}`)
  }

  // Map [start, end] onto parts.
  const chunkSize = manifest.chunkSize
  const firstPart = Math.floor(start / chunkSize)
  const lastPart = Math.floor(end / chunkSize)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        let cursor = start
        for (let i = firstPart; i <= lastPart; i++) {
          const part = parts[i]
          if (!part) {
            controller.error(new Error('missing part'))
            return
          }
          const buf = await fetchPart(part.fileId)
          if (!buf) {
            controller.error(new Error('part fetch failed'))
            return
          }
          const partStart = i * chunkSize
          const from = Math.max(0, cursor - partStart)
          const to = Math.min(buf.byteLength, end - partStart + 1)
          if (to > from) {
            controller.enqueue(new Uint8Array(buf.subarray(from, to)))
            cursor = partStart + to
          }
          if (cursor > end) break
        }
        controller.close()
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error(String(err)))
      }
    },
  })

  return new Response(stream, { status: partial ? 206 : 200, headers })
}

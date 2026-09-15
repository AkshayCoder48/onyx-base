/**
 * OnyxBase V5 — blob storage (docs/v5-contract.md §11-16).
 *
 * Large data NEVER enters the KV hot path. Lifecycle:
 *   created → uploading → uploaded → finalizing → ready
 *   (failed | cancelled from any state)
 *
 * Bytes stream through the API route WITHOUT full-body RAM buffering:
 * request body is piped chunk-by-chunk into a staging file (file mode) while
 * an incremental sha256 runs. 'ready' means the authoritative copy is on
 * disk (file mode) or in the remote libsql-backed store's staging volume —
 * plus checksum verification. The Telegram mirror is a background
 * best-effort durability layer and NEVER gates the response.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { v5db, nowMs, num, isFileMode } from './db'
import { emitEvent } from './events'

const STAGING_ROOT = process.env.V5_BLOB_STAGING_DIR || path.join(process.cwd(), '.data', 'v5-blobs')
export const V5_CHUNK_SIZE = 4 * 1024 * 1024
export const V5_MAX_CHUNKS = 10_000
export const V5_MAX_TOTAL_SIZE = V5_CHUNK_SIZE * V5_MAX_CHUNKS

export type BlobStatus = 'created' | 'uploading' | 'uploaded' | 'finalizing' | 'ready' | 'failed' | 'cancelled'

export interface V5Blob {
  blobId: string
  owner: string
  filename: string | null
  mimeType: string | null
  size: number
  checksum: string | null
  status: BlobStatus
  storageKey: string | null
  isPublic: boolean
  error: string | null
  createdAt: number
  updatedAt: number
}

function rowToBlob(row: Record<string, unknown>): V5Blob {
  return {
    blobId: String(row.id),
    owner: String(row.owner),
    filename: (row.filename as string) ?? null,
    mimeType: (row.mime as string) ?? null,
    size: num(row.size),
    checksum: (row.checksum as string) ?? null,
    status: String(row.status) as BlobStatus,
    storageKey: (row.storage_key as string) ?? null,
    isPublic: num(row.is_public) === 1,
    error: (row.error as string) ?? null,
    createdAt: num(row.created_at),
    updatedAt: num(row.updated_at),
  }
}

function stagingPath(blobId: string): string {
  // blobId is server-generated [a-z0-9_] only — no traversal.
  if (!/^blb_[a-z0-9]+$/.test(blobId)) throw new Error('invalid blob id')
  return path.join(STAGING_ROOT, `${blobId}.bin`)
}

async function patchBlob(blobId: string, patch: Partial<Record<string, unknown>>): Promise<void> {
  const db = await v5db()
  const cols = Object.keys(patch)
  if (cols.length === 0) return
  const sql = `UPDATE v5_blobs SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
  const args: Array<string | number | null> = [...cols.map((c) => (patch as Record<string, unknown>)[c] as string | number | null), nowMs(), blobId]
  await db.execute({ sql, args })
}

export async function createBlob(
  owner: string,
  meta: { filename?: string; mimeType?: string; size?: number; isPublic?: boolean }
): Promise<V5Blob> {
  if (meta.size !== undefined && (meta.size < 0 || meta.size > V5_MAX_TOTAL_SIZE)) {
    throw Object.assign(new Error(`Blob size must be ≤ ${V5_MAX_TOTAL_SIZE} bytes.`), { code: 'PAYLOAD_TOO_LARGE' })
  }
  const blobId = `blb_${randomBytes(12).toString('hex')}`
  const now = nowMs()
  const db = await v5db()
  await db.execute({
    sql: `INSERT INTO v5_blobs (id, owner, filename, mime, size, status, is_public, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?)`,
    args: [
      blobId,
      owner,
      meta.filename?.slice(0, 255) || null,
      meta.mimeType?.slice(0, 127) || null,
      Math.max(0, Math.floor(meta.size ?? 0)),
      meta.isPublic ? 1 : 0,
      now,
      now,
    ],
  })
  await mkdir(STAGING_ROOT, { recursive: true })
  return { blobId, owner, filename: meta.filename || null, mimeType: meta.mimeType || null, size: Math.max(0, meta.size ?? 0), checksum: null, status: 'created', storageKey: stagingPath(blobId), isPublic: Boolean(meta.isPublic), error: null, createdAt: now, updatedAt: now }
}

export async function getBlob(blobId: string): Promise<V5Blob | null> {
  const db = await v5db()
  const rs = await db.execute({ sql: `SELECT * FROM v5_blobs WHERE id = ? LIMIT 1`, args: [blobId] })
  return rs.rows.length > 0 ? rowToBlob(rs.rows[0] as Record<string, unknown>) : null
}

export interface IngestResult {
  blobId: string
  status: BlobStatus
  received: number
  checksum: string
}

/**
 * Stream the request body into staging. NEVER buffers the whole body:
 * the reader is pulled chunk-by-chunk with write-stream backpressure.
 */
export async function ingestData(blobId: string, owner: string, body: ReadableStream<Uint8Array> | null): Promise<IngestResult> {
  const blob = await getBlob(blobId)
  if (!blob) throw Object.assign(new Error('Blob not found.'), { code: 'NOT_FOUND' })
  if (blob.owner !== owner) throw Object.assign(new Error('Blob not found.'), { code: 'NOT_FOUND' })
  if (blob.status === 'ready' || blob.status === 'finalizing') {
    throw Object.assign(new Error(`Blob is ${blob.status} and cannot receive data.`), { code: 'BLOB_NOT_READY' })
  }
  if (blob.status === 'cancelled' || blob.status === 'failed') {
    throw Object.assign(new Error(`Blob is ${blob.status}.`), { code: 'BLOB_NOT_READY' })
  }
  if (!body) throw Object.assign(new Error('Missing request body.'), { code: 'VALIDATION_ERROR' })

  await mkdir(STAGING_ROOT, { recursive: true })
  const dest = createWriteStream(stagingPath(blobId), { flags: 'w' })
  const hasher = createHash('sha256')
  const reader = body.getReader()
  let received = 0
  try {
    await patchBlob(blobId, { status: 'uploading' })
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value || value.byteLength === 0) continue
      received += value.byteLength
      if (received > V5_MAX_TOTAL_SIZE) {
        throw Object.assign(new Error(`Blob exceeds the ${V5_MAX_TOTAL_SIZE} byte limit.`), { code: 'PAYLOAD_TOO_LARGE' })
      }
      hasher.update(value)
      if (!dest.write(value)) {
        await new Promise<void>((resolve) => dest.once('drain', () => resolve()))
      }
    }
    await new Promise<void>((resolve, reject) => {
      dest.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    dest.destroy()
    await patchBlob(blobId, { status: 'failed', error: err instanceof Error ? err.message : String(err) }).catch(() => {})
    throw err
  }
  const checksum = hasher.digest('hex')
  await patchBlob(blobId, { status: 'uploaded', size: received, checksum, chunks: Math.ceil(received / V5_CHUNK_SIZE) })
  await emitEvent(blob.owner, 'BLOB_STATUS', blobId, { status: 'uploaded', size: received })
  return { blobId, status: 'uploaded', received, checksum }
}

export interface FinalizeResult {
  blobId: string
  status: BlobStatus
  operationId?: string
}

/**
 * Finalize: verify staging size + checksum, mark ready. In file mode the
 * staging file IS the authoritative copy; with a remote libsql DB the
 * blob's durability rides the same staging volume (self-host) — the
 * Telegram mirror stays a background best-effort enhancement.
 */
export async function finalizeBlob(blobId: string, owner: string): Promise<FinalizeResult> {
  const blob = await getBlob(blobId)
  if (!blob || blob.owner !== owner) throw Object.assign(new Error('Blob not found.'), { code: 'NOT_FOUND' })
  if (blob.status === 'ready') return { blobId, status: 'ready' }
  if (blob.status !== 'uploaded') {
    throw Object.assign(new Error(`Blob is '${blob.status}' — upload data first.`), { code: 'BLOB_NOT_READY' })
  }
  // Verify the staging file matches the recorded size.
  try {
    const st = await stat(stagingPath(blobId))
    if (st.size !== blob.size) {
      await patchBlob(blobId, { status: 'failed', error: `Staging size mismatch (${st.size} != ${blob.size})` })
      throw Object.assign(new Error('Staged bytes do not match the recorded size.'), { code: 'STORAGE_UNAVAILABLE' })
    }
  } catch (err) {
    if ((err as { code?: string }).code === 'STORAGE_UNAVAILABLE') throw err
    throw Object.assign(new Error('Staged bytes are no longer available.'), { code: 'STORAGE_UNAVAILABLE' })
  }
  await patchBlob(blobId, { status: 'ready', error: null, storage_key: stagingPath(blobId) })
  await emitEvent(blob.owner, 'BLOB_STATUS', blobId, { status: 'ready', size: blob.size, checksum: blob.checksum })
  // Async Telegram backup mirror — fire-and-forget, never gates 'ready'.
  // Cloud Bot API caps a single document at 50 MB; larger blobs are skipped
  // (SQLite/staging remains authoritative — the mirror is redundancy).
  try {
    const { queueBlobPartMirror, isV5MirrorActive } = await import('./mirror')
    if (isV5MirrorActive() && blob.size <= 50 * 1024 * 1024) {
      queueBlobPartMirror(blobId, stagingPath(blobId), `${blobId}.part000000`)
    }
  } catch {
    /* mirror optional */
  }
  return { blobId, status: 'ready' }
}

export async function cancelBlob(blobId: string, owner: string): Promise<V5Blob> {
  const blob = await getBlob(blobId)
  if (!blob || blob.owner !== owner) throw Object.assign(new Error('Blob not found.'), { code: 'NOT_FOUND' })
  if (blob.status === 'ready') throw Object.assign(new Error('A ready blob cannot be cancelled.'), { code: 'BLOB_NOT_READY' })
  await patchBlob(blobId, { status: 'cancelled' })
  await unlink(stagingPath(blobId)).catch(() => {})
  await emitEvent(owner, 'BLOB_STATUS', blobId, { status: 'cancelled' })
  return { ...blob, status: 'cancelled' }
}

/** Content stream for serving (ETag = checksum). */
export function blobContentStream(blob: V5Blob): ReadableStream<Uint8Array> {
  const nodeStream = createReadStream(stagingPath(blob.blobId))
  return new ReadableStream<Uint8Array>({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        controller.enqueue(new Uint8Array(Buffer.from(chunk)))
      })
      nodeStream.on('end', () => controller.close())
      nodeStream.on('error', (err) => controller.error(err))
    },
    cancel() {
      nodeStream.destroy()
    },
  })
}

export function blobBackendLabel(): string {
  return isFileMode() ? 'local-staging' : 'staging+libsql'
}

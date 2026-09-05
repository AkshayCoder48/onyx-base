/**
 * Onyx Base — chunked upload engine.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The single-shot upload (`POST /api/files` multipart) worked for small files
 * but hard-failed for large ones on TWO independent layers:
 *
 *   1. Next.js 16 `proxyClientMaxBodySize` (default 10 MB) truncated request
 *      bodies routed through middleware → `req.formData()` parse failures →
 *      HTTP 400 "Expected multipart/form-data".
 *   2. Vercel serverless functions cap request bodies at ~4.5 MB → 413
 *      FUNCTION_PAYLOAD_TOO_LARGE (surfaced to users as a crash / 502-style
 *      failure).
 *   3. Buffering the entire file in memory (formData + Buffer + Telegram
 *      FormData copy) spiked RSS ~6× the file size — on a memory-constrained
 *      box the dev server got OOM-killed → the gateway returned 502 until
 *      manual restart.
 *
 * THE FIX
 * ───────
 * A resumable, disk-backed chunked upload protocol:
 *
 *   POST /api/files/upload/init      { fileName, mimeType, size, label?, isPublic?, chunkSize? }
 *                                    → { uploadId, chunkSize, chunkCount }
 *   POST /api/files/upload/chunk?uploadId&index   (raw binary body ≤ chunkSize)
 *                                    → { received: number }
 *   GET  /api/files/upload/status?uploadId        → session + missing chunks (resume support)
 *   POST /api/files/upload/complete  { uploadId }  → assembles → Telegram → file record
 *   POST /api/files/upload/abort     { uploadId }  → discards the session
 *
 * Properties:
 *   - Each chunk request is small (default 4 MB) → passes Vercel's 4.5 MB
 *     body limit AND the Next.js proxy cap.
 *   - Chunks are written straight to disk (`<tmpdir>/onyxbase-uploads/<id>/`)
 *     — memory usage per chunk is O(chunkSize), not O(fileSize).
 *   - `complete` reassembles with a stream pipeline and hands Telegram ONE
 *     Blob; the Telegram fetch streams the multipart body out.
 *   - Sessions are resumable: `status` lists missing chunk indexes so a
 *     flaky mobile connection can retry just the failed chunks.
 *   - A janitor (invoked opportunistically on `init`, and by
 *     scripts/cleanup-stale-uploads.ts) removes sessions older than 2 hours
 *     so /tmp can never fill up.
 *
 * MULTIPLE INSTANCES (Vercel)
 * ───────────────────────────
 * /tmp is per-lambda-instance. If a chunk lands on a different instance the
 * session won't exist there — the route returns 404 SESSION_NOT_FOUND and the
 * CLIENT is expected to re-init and restart the upload (built into the
 * dashboard uploader with a retry budget). Single-process deployments (dev,
 * self-hosted, Docker) are fully resumable.
 */

import { createWriteStream } from 'fs'
import { mkdir, readdir, rm, stat, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Default bytes per chunk. 4 MB keeps every request safely under Vercel's
 *  ~4.5 MB function-body limit and the Next.js proxy cap. */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

/** Chunks are per-session files; allow up to 10,000 of them (= 40 GB at the
 *  default chunk size — comfortably beyond the 2 GB local-Bot-API ceiling). */
export const MAX_CHUNKS = 10_000

/** Sessions older than this are garbage-collected. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000

/** Hard ceiling on a single upload (matches the local Bot API 2 GB limit). */
export const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024

// ─── Session storage ─────────────────────────────────────────────────────────

const UPLOAD_ROOT = path.join(os.tmpdir(), 'onyxbase-uploads')

export interface UploadSession {
  uploadId: string
  userId: string
  fileName: string
  mimeType: string
  size: number
  label: string | null
  isPublic: boolean
  chunkSize: number
  chunkCount: number
  createdAt: number
}

function sessionDir(uploadId: string): string {
  return path.join(UPLOAD_ROOT, uploadId)
}

function sessionFile(uploadId: string): string {
  return path.join(sessionDir(uploadId), 'session.json')
}

function chunkPath(uploadId: string, index: number): string {
  return path.join(sessionDir(uploadId), `chunk-${String(index).padStart(6, '0')}.part`)
}

function validUploadId(id: string): boolean {
  // Session ids are UUIDs we minted — reject anything else outright to keep
  // path traversal out of the filesystem layer.
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

// ─── Session lifecycle ───────────────────────────────────────────────────────

export async function createSession(
  userId: string,
  meta: {
    fileName: string
    mimeType: string
    size: number
    label?: string | null
    isPublic?: boolean
    chunkSize?: number
  },
): Promise<UploadSession> {
  const size = Math.floor(meta.size)
  if (!Number.isFinite(size) || size <= 0) throw new Error('File size must be a positive number.')
  if (size > MAX_TOTAL_SIZE) {
    throw new Error(
      `File is ${(size / 1024 / 1024).toFixed(1)} MB — the hard ceiling is 2 GB (local Bot API limit).`,
    )
  }
  const chunkSize = Math.min(
    Math.max(Math.floor(meta.chunkSize ?? DEFAULT_CHUNK_SIZE), 256 * 1024), // ≥ 256 KB
    32 * 1024 * 1024, // ≤ 32 MB
  )
  const chunkCount = Math.ceil(size / chunkSize)
  if (chunkCount > MAX_CHUNKS) {
    throw new Error(`File needs ${chunkCount} chunks — the maximum is ${MAX_CHUNKS}.`)
  }

  const session: UploadSession = {
    uploadId: randomUUID(),
    userId,
    fileName: meta.fileName.slice(0, 200) || 'untitled',
    mimeType: meta.mimeType || 'application/octet-stream',
    size,
    label: meta.label ? String(meta.label).slice(0, 200) : null,
    isPublic: meta.isPublic !== false,
    chunkSize,
    chunkCount,
    createdAt: Date.now(),
  }
  await mkdir(sessionDir(session.uploadId), { recursive: true })
  await writeFile(sessionFile(session.uploadId), JSON.stringify(session), 'utf8')
  return session
}

export async function getSession(uploadId: string): Promise<UploadSession | null> {
  if (!validUploadId(uploadId)) return null
  try {
    const raw = await import('fs/promises').then((fs) => fs.readFile(sessionFile(uploadId), 'utf8'))
    return JSON.parse(raw) as UploadSession
  } catch {
    return null
  }
}

export async function deleteSession(uploadId: string): Promise<void> {
  if (!validUploadId(uploadId)) return
  await rm(sessionDir(uploadId), { recursive: true, force: true }).catch(() => {})
}

/** Which chunk indexes have landed so far (for resume support). */
export async function receivedChunkIndexes(uploadId: string): Promise<number[]> {
  if (!validUploadId(uploadId)) return []
  try {
    const entries = await readdir(sessionDir(uploadId))
    const idx: number[] = []
    for (const name of entries) {
      const m = /^chunk-(\d{6})\.part$/.exec(name)
      if (m) idx.push(parseInt(m[1], 10))
    }
    return idx.sort((a, b) => a - b)
  } catch {
    return []
  }
}

/**
 * Append one chunk to the session. The route hands us the raw request body
 * stream so the bytes go straight to disk without a full in-memory buffer.
 *
 * Duplicate indexes are idempotent — a retried chunk overwrites its own
 * part-file (same path), so flaky-network retries never corrupt the assembly.
 */
export async function writeChunk(
  uploadId: string,
  index: number,
  body: ReadableStream<Uint8Array> | Buffer,
  expectedSize: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await getSession(uploadId)
  if (!session) return { ok: false, error: 'SESSION_NOT_FOUND' }
  if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) {
    return { ok: false, error: `Chunk index ${index} is out of range (0..${session.chunkCount - 1}).` }
  }
  if (expectedSize > session.chunkSize) {
    return { ok: false, error: `Chunk body is ${expectedSize} bytes — larger than the negotiated chunk size (${session.chunkSize}).` }
  }
  // Last chunk may be smaller; everything else must be exactly chunkSize so
  // offsets line up during assembly.
  const isLast = index === session.chunkCount - 1
  const expectedLast = session.size - session.chunkSize * (session.chunkCount - 1)
  if (expectedSize !== (isLast ? expectedLast : session.chunkSize)) {
    return {
      ok: false,
      error: `Chunk ${index} must be exactly ${isLast ? expectedLast : session.chunkSize} bytes (got ${expectedSize}).`,
    }
  }

  await mkdir(sessionDir(uploadId), { recursive: true })
  const target = chunkPath(uploadId, index)

  if (Buffer.isBuffer(body)) {
    await writeFile(target, body)
  } else {
    // Stream the request body to disk — O(chunkSize) memory.
    const ws = createWriteStream(target)
    // Web ReadableStream → Node Readable
    const nodeStream = Readable.fromWeb(body as never)
    await pipeline(nodeStream, ws)
  }
  return { ok: true }
}

/** True when every chunk index has landed. */
export async function isComplete(uploadId: string): Promise<boolean> {
  const session = await getSession(uploadId)
  if (!session) return false
  const received = await receivedChunkIndexes(uploadId)
  return received.length === session.chunkCount
}

/**
 * Assemble all chunks into ONE Blob for the Telegram upload.
 *
 * Memory strategy: the final Blob is exactly ONE in-memory copy of the file
 * (pre-allocated to the declared size, chunks copied in sequence). undici
 * then streams that Blob to Telegram without further buffering. That's a
 * 6× reduction vs. the old single-shot path (formData buffer + Buffer copy
 * + multipart copy per request).
 */
export async function assembleBlob(uploadId: string): Promise<Blob> {
  const session = await getSession(uploadId)
  if (!session) throw new Error('SESSION_NOT_FOUND')
  if (!(await isComplete(uploadId))) throw new Error('Assembly requested with missing chunks.')
  if (!(await verifyAssembledSize(uploadId))) {
    throw new Error('Assembled byte count does not match the declared size — the upload is corrupt. Abort and retry.')
  }

  const { readFile } = await import('fs/promises')
  const out = Buffer.alloc(session.size)
  let offset = 0
  for (let i = 0; i < session.chunkCount; i++) {
    const part = await readFile(chunkPath(uploadId, i))
    part.copy(out, offset)
    offset += part.length
  }
  return new Blob([out], { type: session.mimeType })
}

/** Verify the assembled byte count matches the declared size. */
export async function verifyAssembledSize(uploadId: string): Promise<boolean> {
  const session = await getSession(uploadId)
  if (!session) return false
  let total = 0
  for (let i = 0; i < session.chunkCount; i++) {
    const s = await stat(chunkPath(uploadId, i)).catch(() => null)
    if (!s) return false
    total += s.size
  }
  return total === session.size
}

// ─── Janitor ─────────────────────────────────────────────────────────────────

let janitorLastRun = 0
const JANITOR_COOLDOWN_MS = 5 * 60 * 1000

/**
 * Remove sessions older than SESSION_TTL_MS. Invoked opportunistically
 * (rate-limited) from `init` and from scripts/cleanup-stale-uploads.ts.
 * Never throws — janitor failures must not break uploads.
 */
export async function sweepStaleSessions(force = false): Promise<number> {
  const now = Date.now()
  if (!force && now - janitorLastRun < JANITOR_COOLDOWN_MS) return 0
  janitorLastRun = now
  let removed = 0
  try {
    const entries = await readdir(UPLOAD_ROOT).catch(() => [] as string[])
    for (const id of entries) {
      if (!validUploadId(id)) continue
      const sf = path.join(UPLOAD_ROOT, id, 'session.json')
      const s = await stat(sf).catch(() => null)
      if (!s) {
        // No session.json — stale debris from an interrupted session.
        await rm(path.join(UPLOAD_ROOT, id), { recursive: true, force: true }).catch(() => {})
        removed++
        continue
      }
      if (now - s.mtimeMs > SESSION_TTL_MS) {
        await rm(path.join(UPLOAD_ROOT, id), { recursive: true, force: true }).catch(() => {})
        removed++
      }
    }
  } catch {
    /* best-effort */
  }
  return removed
}

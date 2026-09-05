/**
 * Onyx Base — chunked upload engine, protocol v2 (STATELESS).
 *
 * WHY v1 FAILED ON VERCEL
 * ───────────────────────
 * v1 kept upload sessions + chunk part-files in `<tmpdir>/onyxbase-uploads/`.
 * On a single process (dev, Docker, self-hosted) that is fine. On Vercel every
 * request may land on a DIFFERENT lambda instance — each with its own private
 * /tmp — so `init` landed on instance A while `chunk 0` hit instance B and got
 * 404 SESSION_NOT_FOUND. With N warm instances the odds of a whole transfer
 * staying on one instance are (1/N)^(chunks+1) — effectively zero.
 *
 * WHY v1 EXISTED AT ALL
 * ─────────────────────
 * The single-shot upload (`POST /api/files` multipart) hard-failed for large
 * files on three independent layers:
 *   1. Next.js 16 `proxyClientMaxBodySize` (default 10 MB) truncated request
 *      bodies routed through middleware → `req.formData()` parse failures.
 *   2. Vercel serverless functions cap request bodies at ~4.5 MB → 413.
 *   3. Buffering the whole file in memory spiked RSS ~6× file size — the dev
 *      server got OOM-killed → gateway 502 until manual restart.
 *
 * PROTOCOL v2 — STATELESS, TELEGRAM-STAGED
 * ───────────────────────────────────────
 * The ONLY durable layer shared by every instance is Telegram itself (it is
 * already the storage backend for every KV record and file). So v2 stages
 * each chunk AS a Telegram document immediately, keeps zero server-side
 * session state, and lets the CLIENT collect the Telegram message references:
 *
 *   POST /api/files/upload/init      { fileName, mimeType, size, label?, isPublic?, chunkSize? }
 *                                    → { uploadId, chunkSize, chunkCount, … }   (pure math — no state)
 *   POST /api/files/upload/chunk?uploadId&index&chunkCount&chunkSize&size&fileName
 *                                    (raw binary body ≤ chunkSize)
 *                                    → { messageId, fileId, storageMode, botApiBaseUrl }
 *   POST /api/files/upload/status    { uploadId, chunkCount, chunkSize, size, chunks:[{index,fileId}] }
 *                                    → { complete, missing, verified }          (getFile metadata only)
 *   POST /api/files/upload/complete  { uploadId, fileName, mimeType, size, chunkSize, chunkCount,
 *                                      label?, isPublic?, chunks:[{index,messageId,fileId,storageMode?}] }
 *                                    → assembles → Telegram → file record (same shape as /api/files)
 *   POST /api/files/upload/abort     { uploadId, chunks:[{messageId,storageMode?}] }
 *                                    → deletes the staged Telegram messages (best-effort)
 *
 * Properties:
 *   - Multi-instance safe by construction: no server-side state, no affinity.
 *   - Each chunk request is small (4 MB) → passes Vercel's ~4.5 MB body limit
 *     AND the Next.js proxy cap.
 *   - Memory per chunk request is O(chunkSize) — one Blob sent straight to
 *     Telegram, never the whole file.
 *   - `complete` downloads the staged chunks and reassembles; peak memory is
 *     one in-memory copy of the final file (same as single-shot), and the
 *     download step is capped at 20 MB per getFile on the cloud Bot API —
 *     4 MB chunks are always under it.
 *   - Idempotent-ish: a retried chunk sends a NEW Telegram document; the
 *     client keeps the newest ref per index (older duplicates are deleted at
 *     complete/abort time when their refs were collected).
 *   - A janitor (sweepStaleSessions + scripts/cleanup-stale-uploads.ts)
 *     removes crashed `complete` workspaces from /tmp; staged Telegram
 *     messages are cleaned by complete/abort (documented limitation: if the
 *     client vanishes mid-transfer without calling abort, its part-messages
 *     remain in the storage chat until manually removed).
 *
 * SIZE CEILINGS (unchanged from v1, enforced at init AND complete):
 *   - Cloud Bot API:  50 MB per stored file (sendDocument limit).
 *   - Local Bot API:   2 GB per stored file.
 *   - Hard ceiling: 2 GB + MAX_CHUNKS × chunkSize bound.
 */

import { createWriteStream } from 'fs'
import { mkdir, rm, readFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { pipeline } from 'stream/promises'
import { Readable } from 'stream'

import { deleteKvMessage, getFileDownloadUrl } from '@/lib/telegram'

// ─── Tunables ────────────────────────────────────────────────────────────────

/** Default bytes per chunk. 4 MB keeps every request safely under Vercel's
 *  ~4.5 MB function-body limit, the Next.js proxy cap, AND the cloud Bot API
 *  20 MB getFile download limit. */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

/** Chunks per upload ceiling (= 40 GB at the default chunk size — comfortably
 *  beyond the 2 GB local-Bot-API ceiling). */
export const MAX_CHUNKS = 10_000

/** Hard ceiling on a single upload (matches the local Bot API 2 GB limit). */
export const MAX_TOTAL_SIZE = 2 * 1024 * 1024 * 1024

/** Workspaces older than this are garbage-collected from /tmp. */
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000

// ─── Plan (pure functions — no I/O, no state) ────────────────────────────────

/** The upload plan: everything the client needs to drive the transfer. */
export interface UploadPlan {
  uploadId: string
  fileName: string
  mimeType: string
  size: number
  label: string | null
  isPublic: boolean
  chunkSize: number
  chunkCount: number
}

/**
 * Validate metadata and mint an upload plan. STATELESS — the server stores
 * nothing; the client echoes the plan fields on every subsequent request and
 * the server re-validates them each time.
 */
export function planUpload(meta: {
  fileName: string
  mimeType: string
  size: number
  label?: string | null
  isPublic?: boolean
  chunkSize?: number
}): UploadPlan {
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
  return {
    uploadId: randomUUID(),
    fileName: meta.fileName.slice(0, 200) || 'untitled',
    mimeType: meta.mimeType || 'application/octet-stream',
    size,
    label: meta.label ? String(meta.label).slice(0, 200) : null,
    isPublic: meta.isPublic !== false,
    chunkSize,
    chunkCount,
  }
}

/** Bytes the chunk at `index` must carry (all but the last are exactly
 *  chunkSize; the last carries the remainder). */
export function chunkExpectedSize(size: number, chunkSize: number, chunkCount: number, index: number): number {
  const isLast = index === chunkCount - 1
  return isLast ? size - chunkSize * (chunkCount - 1) : chunkSize
}

/** Telegram document filename for a staged chunk — encodes the uploadId so the
 *  part-files are self-describing in the storage chat. */
export function partFileName(uploadId: string, index: number): string {
  return `${uploadId}.part${String(index).padStart(6, '0')}`
}

/** Ownership + provenance tag stored in the document's Telegram caption. */
export function stagingCaption(dbUserId: string, plan: Pick<UploadPlan, 'size' | 'chunkCount'>): string {
  return `onyxbase-upload|${dbUserId}|${plan.size}|${plan.chunkCount}`
}

/** Session/upload ids are UUIDs we minted — reject anything else outright to
 *  keep path traversal and junk params out of the filesystem layer. */
export function validUploadId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

// ─── Client-collected chunk references ───────────────────────────────────────

/** What the server returns per chunk and the client collects for
 *  status/complete/abort. */
export interface ChunkRef {
  index: number
  messageId: number
  fileId: string
  /** Which Telegram backend staged this chunk ('server' env bot or the user's
   *  'custom' bot) — captured at staging time so complete/abort can resolve
   *  the right bot even if the user's config changed mid-transfer. */
  storageMode?: 'server' | 'custom'
  /** The Bot API base URL in effect when staged (null/'' = cloud). */
  botApiBaseUrl?: string | null
}

/** Validate that the refs cover exactly indexes 0..chunkCount-1, each once. */
export function validateChunkRefs(
  chunkCount: number,
  refs: { index: number }[],
): { ok: true; indexes: number[] } | { ok: false; error: string } {
  if (!Array.isArray(refs) || refs.length !== chunkCount) {
    return { ok: false, error: `Expected exactly ${chunkCount} chunk references — got ${Array.isArray(refs) ? refs.length : 'none'}.` }
  }
  const seen = new Set<number>()
  for (const r of refs) {
    if (!Number.isInteger(r.index) || r.index < 0 || r.index >= chunkCount) {
      return { ok: false, error: `Chunk index ${r.index} is out of range (0..${chunkCount - 1}).` }
    }
    if (seen.has(r.index)) {
      return { ok: false, error: `Chunk index ${r.index} appears more than once.` }
    }
    seen.add(r.index)
  }
  return { ok: true, indexes: [...seen].sort((a, b) => a - b) }
}

// ─── Assembly (runs inside ONE request — /tmp is transient) ──────────────────

const UPLOAD_ROOT = path.join(os.tmpdir(), 'onyxbase-uploads')

/** How to reach the bot that staged a given chunk (resolved by the caller from
 *  the ref's storageMode — keeps this lib free of data-store imports). */
export interface BotTarget {
  botToken: string
  botApiBaseUrl: string
}

/**
 * Download all staged chunks and assemble them into ONE Blob for the final
 * Telegram upload.
 *
 * Verifies, per chunk, that Telegram's reported file size matches the expected
 * chunk size BEFORE downloading — corrupt or superseded parts fail fast with a
 * clear error instead of producing a corrupt file.
 *
 * Memory strategy: identical to v1 — the final Blob is exactly ONE in-memory
 * copy of the file. The per-chunk downloads stream to a transient /tmp
 * workspace which is ALWAYS removed before returning.
 */
export async function downloadAndAssemble(
  plan: Pick<UploadPlan, 'size' | 'chunkSize' | 'chunkCount' | 'mimeType'>,
  refs: (ChunkRef & { bot: BotTarget })[],
): Promise<Blob> {
  const workspace = path.join(UPLOAD_ROOT, randomUUID())
  await mkdir(workspace, { recursive: true })
  try {
    const parts: Buffer[] = []
    for (const ref of refs) {
      const expected = chunkExpectedSize(plan.size, plan.chunkSize, plan.chunkCount, ref.index)
      const resolved = await getFileDownloadUrl(ref.fileId, ref.bot.botToken, ref.bot.botApiBaseUrl)
      if (!resolved) {
        throw new Error(`Chunk ${ref.index}: Telegram could not resolve the staged file (getFile failed).`)
      }
      if (resolved.fileSize !== null && resolved.fileSize !== expected) {
        throw new Error(
          `Chunk ${ref.index} is ${resolved.fileSize} bytes on Telegram but ${expected} were declared — the transfer is inconsistent. Abort and retry.`,
        )
      }
      const res = await fetch(resolved.url)
      if (!res.ok || !res.body) {
        throw new Error(`Chunk ${ref.index}: download failed (HTTP ${res.status}).`)
      }
      // Stream to the transient workspace — O(chunkSize) memory.
      const target = path.join(workspace, `chunk-${String(ref.index).padStart(6, '0')}.part`)
      const ws = createWriteStream(target)
      await pipeline(Readable.fromWeb(res.body as never), ws)
      const buf = await readFile(target)
      if (buf.length !== expected) {
        throw new Error(
          `Chunk ${ref.index} downloaded as ${buf.length} bytes — expected ${expected}. The transfer is corrupt; abort and retry.`,
        )
      }
      parts[ref.index] = buf
    }
    const out = Buffer.concat(parts, plan.size)
    if (out.length !== plan.size) {
      throw new Error(
        `Assembled byte count (${out.length}) does not match the declared size (${plan.size}) — the upload is corrupt. Abort and retry.`,
      )
    }
    return new Blob([out], { type: plan.mimeType })
  } finally {
    // ALWAYS remove the transient workspace — crashed or not.
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

// ─── Staged-message cleanup ──────────────────────────────────────────────────

/** Delete staged chunk documents from Telegram (best-effort, never throws). */
export async function deleteStagedChunks(
  refs: { messageId: number; chatId: string; botToken: string; botApiBaseUrl: string }[],
): Promise<number> {
  let deleted = 0
  for (const r of refs) {
    if (!Number.isInteger(r.messageId) || r.messageId <= 0) continue
    const ok = await deleteKvMessage(r.messageId, r.chatId, r.botToken, r.botApiBaseUrl).catch(() => false)
    if (ok) deleted++
  }
  return deleted
}

// ─── Janitor (transient /tmp workspaces) ─────────────────────────────────────

let janitorLastRun = 0
const JANITOR_COOLDOWN_MS = 5 * 60 * 1000

/**
 * Remove stale directories under the upload root. v2 keeps NO sessions — only
 * transient assembly workspaces from crashed `complete` calls (they contain no
 * session.json, so the "no session.json → debris" branch sweeps them). Invoked
 * opportunistically (rate-limited) from `init` and by
 * scripts/cleanup-stale-uploads.ts. Never throws.
 */
export async function sweepStaleSessions(force = false): Promise<number> {
  const now = Date.now()
  if (!force && now - janitorLastRun < JANITOR_COOLDOWN_MS) return 0
  janitorLastRun = now
  let removed = 0
  try {
    const { readdir, stat } = await import('fs/promises')
    const entries = await readdir(UPLOAD_ROOT).catch(() => [] as string[])
    for (const id of entries) {
      if (!validUploadId(id)) continue
      const dir = path.join(UPLOAD_ROOT, id)
      const s = await stat(dir).catch(() => null)
      if (!s || !s.isDirectory()) continue
      // Age by directory mtime: old debris (v1 sessions, v2 crashed assembly
      // workspaces) goes; fresh in-flight workspaces stay.
      if (now - s.mtimeMs > SESSION_TTL_MS) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        removed++
      }
    }
  } catch {
    /* best-effort */
  }
  return removed
}

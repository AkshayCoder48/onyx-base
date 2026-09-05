/**
 * Onyx Base — client-side resilient uploader (protocol v2).
 *
 * Automatically picks the transport:
 *   - ≤ SINGLE_SHOT_LIMIT (8 MB): legacy single-shot multipart POST /api/files
 *     (one request, lowest latency).
 *   - > SINGLE_SHOT_LIMIT: the STATELESS chunked protocol:
 *       init → chunk ×N → complete
 *     Each chunk is staged as a Telegram document (4 MB per request — under
 *     every platform's body limit), the client collects the { messageId,
 *     fileId } refs, and `complete` hands the whole set back so ANY server
 *     instance can download + assemble + register the file. No server-side
 *     session exists, so instance routing doesn't matter.
 *
 * Resilience:
 *   - per-chunk network retries (bounded) with re-slice from the File object
 *   - on give-up: `abort` is called with all collected refs so the storage
 *     chat is cleaned of staged part-messages
 *   - progress events { sentBytes, totalBytes, phase } drive a real progress
 *     bar in the storage UI.
 */

export interface UploadProgress {
  phase: 'single' | 'init' | 'chunks' | 'complete'
  sentBytes: number
  totalBytes: number
}

export interface UploadedFile {
  id: string
  fileId: string
  fileName: string
  downloadUrl: string
  size: number
  [k: string]: unknown
}

/** Below this size a single multipart request is the better transport. */
export const SINGLE_SHOT_LIMIT = 8 * 1024 * 1024

/** 4 MB chunks sit safely under every hop's body limit. */
const CHUNK_SIZE = 4 * 1024 * 1024

/** Per-chunk network retries before giving up. */
const CHUNK_RETRIES = 3

export interface UploadOptions {
  label?: string | null
  isPublic?: boolean
  onProgress?: (p: UploadProgress) => void
  signal?: AbortSignal
}

interface InitResponse {
  ok: boolean
  uploadId?: string
  chunkSize?: number
  chunkCount?: number
  error?: string
}

interface ChunkResponse {
  ok: boolean
  messageId?: number
  fileId?: string
  storageMode?: 'server' | 'custom'
  botApiBaseUrl?: string | null
  error?: string
}

interface CompleteResponse {
  ok: boolean
  file?: UploadedFile
  error?: string
}

function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` }
}

/** Sleep helper for retry backoff. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Upload a File with automatic transport selection and bounded retries.
 * Throws Error with a human-readable message on final failure (after having
 * cleaned up any staged chunks via abort).
 */
export async function uploadFileResilient(
  apiKey: string | null | undefined,
  file: File,
  opts: UploadOptions = {},
): Promise<UploadedFile> {
  if (!apiKey) throw new Error('Sign in with your API key first.')
  if (file.size <= SINGLE_SHOT_LIMIT) {
    return singleShot(apiKey, file, opts)
  }
  return chunked(apiKey, file, opts)
}

// ─── Single-shot (≤ 8 MB) ─────────────────────────────────────────────────────

async function singleShot(apiKey: string, file: File, opts: UploadOptions): Promise<UploadedFile> {
  opts.onProgress?.({ phase: 'single', sentBytes: 0, totalBytes: file.size })
  const form = new FormData()
  form.append('file', file, file.name)
  if (opts.label) form.append('label', opts.label)
  if (opts.isPublic === false) form.append('isPublic', 'false')

  const res = await fetch('/api/files', {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal: opts.signal,
  })
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; file?: UploadedFile; error?: string }
  if (!res.ok || !data.ok || !data.file) {
    throw new Error(data.error || `Upload failed (HTTP ${res.status}).`)
  }
  opts.onProgress?.({ phase: 'complete', sentBytes: file.size, totalBytes: file.size })
  return data.file
}

// ─── Chunked protocol v2 (> 8 MB) ────────────────────────────────────────────

async function chunked(apiKey: string, file: File, opts: UploadOptions): Promise<UploadedFile> {
  const total = file.size

  // 1. init — mint the plan (stateless).
  opts.onProgress?.({ phase: 'init', sentBytes: 0, totalBytes: total })
  let init = await postJson<InitResponse>('/api/files/upload/init', apiKey, {
    fileName: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: total,
    label: opts.label ?? null,
    isPublic: opts.isPublic !== false,
    chunkSize: CHUNK_SIZE,
  })
  if (!init.ok || !init.uploadId) {
    throw new Error(init.error || 'Upload init failed.')
  }
  const uploadId = init.uploadId
  const chunkSize = init.chunkSize ?? CHUNK_SIZE
  const chunkCount = init.chunkCount ?? Math.ceil(total / chunkSize)

  // Collected refs — newest per index wins (a retried chunk stages a NEW
  // document; superseded refs are kept in `allRefs` so abort/complete can
  // delete them too).
  const latest = new Map<number, ChunkResponse & { index: number }>()
  const allRefs: { index: number; messageId: number; fileId: string; storageMode?: 'server' | 'custom'; botApiBaseUrl?: string | null }[] = []
  let sentBytes = 0

  try {
    // 2. chunks — stage each slice as a Telegram document.
    for (let i = 0; i < chunkCount; i++) {
      if (opts.signal?.aborted) throw new Error('Upload cancelled.')
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, total)
      const blob = file.slice(start, end)

      let attempt = 0
      for (;;) {
        try {
          const res = await fetch(
            `/api/files/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}` +
              `&chunkCount=${chunkCount}&chunkSize=${chunkSize}&size=${total}`,
            {
              method: 'POST',
              headers: { ...authHeaders(apiKey), 'Content-Type': 'application/octet-stream' },
              body: blob,
              signal: opts.signal,
            },
          )
          const data = (await res.json().catch(() => ({}))) as ChunkResponse
          if (!res.ok || !data.ok || typeof data.messageId !== 'number' || !data.fileId) {
            throw new Error(data.error || `Chunk ${i} failed (HTTP ${res.status}).`)
          }
          const ref = { ...data, index: i }
          latest.set(i, ref)
          allRefs.push({ index: i, messageId: data.messageId, fileId: data.fileId, storageMode: data.storageMode, botApiBaseUrl: data.botApiBaseUrl })
          break
        } catch (err) {
          attempt++
          if (attempt > CHUNK_RETRIES) throw err
          await sleep(300 * attempt)
        }
      }

      sentBytes = end
      opts.onProgress?.({ phase: 'chunks', sentBytes, totalBytes: total })
    }

    // 3. complete — hand the full ref set back; server downloads + assembles.
    opts.onProgress?.({ phase: 'complete', sentBytes, totalBytes: total })
    const chunks = [...latest.values()]
      .sort((a, b) => a.index - b.index)
      .map((r) => ({ index: r.index, messageId: r.messageId, fileId: r.fileId, storageMode: r.storageMode, botApiBaseUrl: r.botApiBaseUrl }))

    const done = await postJson<CompleteResponse>('/api/files/upload/complete', apiKey, {
      uploadId,
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: total,
      chunkSize,
      chunkCount,
      label: opts.label ?? null,
      isPublic: opts.isPublic !== false,
      chunks,
    })
    if (!done.ok || !done.file) {
      throw new Error(done.error || 'Upload completion failed.')
    }
    return done.file
  } catch (err) {
    // Give-up → clean the staged Telegram documents (best-effort).
    await postJson('/api/files/upload/abort', apiKey, { uploadId, chunks: allRefs }).catch(() => {})
    throw err
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

async function postJson<T extends { ok?: boolean; error?: string }>(
  url: string,
  apiKey: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...authHeaders(apiKey), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  })
  return (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as T
}

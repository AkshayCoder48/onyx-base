/**
 * Onyx Base — client-side resilient uploader.
 *
 * Automatically picks the transport:
 *   - ≤ SINGLE_SHOT_LIMIT (8 MB): legacy single-shot multipart POST /api/files
 *     (one request, lowest latency).
 *   - > SINGLE_SHOT_LIMIT: the chunked protocol
 *     (POST /api/files/upload/init → chunk ×N → complete), which:
 *       • passes Vercel's ~4.5 MB per-request body limit,
 *       • passes the Next.js proxy body cap,
 *       • keeps server memory O(chunk) instead of O(file),
 *       • retries individual chunks on flaky networks,
 *       • restarts the whole transfer (bounded retries) if the session
 *         expired or landed on a different server instance.
 *
 * Reports progress as { sentBytes, totalBytes, phase } so the UI can render
 * a real progress bar instead of a spinner.
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

/** Full-transfer restarts (e.g. session lost across instances). */
const TRANSFER_RESTARTS = 2

interface InitResponse {
  ok: boolean
  uploadId?: string
  chunkSize?: number
  chunkCount?: number
  error?: string
}

interface ChunkResponse {
  ok: boolean
  error?: string
}

interface CompleteResponse {
  ok: boolean
  file?: UploadedFile
  error?: string
}

async function jsonFetch<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.body && !(init.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const body = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) {
    const err = new Error(body?.error || `Request failed (${res.status} ${url})`)
    ;(err as Error & { status?: number }).status = res.status
    throw err
  }
  return body
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** The chunked transfer, one attempt end-to-end. Throws on failure. */
async function chunkedTransfer(
  file: File,
  apiKey: string,
  opts: { label?: string; isPublic?: boolean },
  onProgress: (p: UploadProgress) => void,
): Promise<UploadedFile> {
  // 1. Init
  onProgress({ phase: 'init', sentBytes: 0, totalBytes: file.size })
  const init = await jsonFetch<InitResponse>('/api/files/upload/init', apiKey, {
    method: 'POST',
    body: JSON.stringify({
      fileName: file.name,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      label: opts.label?.trim() || undefined,
      isPublic: opts.isPublic !== false,
      chunkSize: CHUNK_SIZE,
    }),
  })
  const uploadId = init.uploadId!
  const chunkSize = init.chunkSize ?? CHUNK_SIZE
  const chunkCount = init.chunkCount ?? Math.ceil(file.size / chunkSize)

  // 2. Chunks — sequential keeps memory flat and gives smooth progress;
  //    retry each chunk individually on transient errors.
  let sentBytes = 0
  for (let i = 0; i < chunkCount; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const blob = file.slice(start, end)

    let attempt = 0
    for (;;) {
      try {
        await jsonFetch<ChunkResponse>(
          `/api/files/upload/chunk?uploadId=${encodeURIComponent(uploadId)}&index=${i}`,
          apiKey,
          { method: 'POST', body: blob }, // raw binary — no Content-Type header
        )
        sentBytes += blob.size
        onProgress({ phase: 'chunks', sentBytes, totalBytes: file.size })
        break
      } catch (err) {
        attempt++
        const status = (err as Error & { status?: number }).status
        // Session gone → let the outer loop restart the whole transfer.
        if (status === 404) throw err
        if (attempt >= CHUNK_RETRIES) throw err
        await delay(400 * attempt) // linear-ish backoff
      }
    }
  }

  // 3. Complete — server assembles, ships to Telegram, registers the record.
  onProgress({ phase: 'complete', sentBytes: file.size, totalBytes: file.size })
  const done = await jsonFetch<CompleteResponse>('/api/files/upload/complete', apiKey, {
    method: 'POST',
    body: JSON.stringify({ uploadId }),
  })
  if (!done.file) throw new Error('Upload completed but no file record was returned.')
  return done.file
}

/**
 * Upload a file with the best transport for its size.
 *
 * Throws Error (with .status when known) after all retries — the caller shows
 * the message to the user.
 */
export async function uploadFileResilient(
  apiKey: string,
  file: File,
  opts: { label?: string; isPublic?: boolean } = {},
  onProgress: (p: UploadProgress) => void = () => {},
): Promise<UploadedFile> {
  // Fast path — single multipart request.
  if (file.size <= SINGLE_SHOT_LIMIT) {
    onProgress({ phase: 'single', sentBytes: file.size, totalBytes: file.size })
    const form = new FormData()
    form.append('file', file)
    if (opts.label?.trim()) form.append('label', opts.label.trim())
    form.append('public', (opts.isPublic !== false).toString())
    const res = await fetch('/api/files', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; file?: UploadedFile; error?: string }
    if (!res.ok || !json.file) throw new Error(json.error || `Upload failed (${res.status})`)
    return json.file
  }

  // Resilient chunked path with bounded full restarts (covers session loss
  // across serverless instances and hard network drops mid-transfer).
  let restart = 0
  for (;;) {
    try {
      return await chunkedTransfer(file, apiKey, opts, onProgress)
    } catch (err) {
      const status = (err as Error & { status?: number }).status
      // Fail fast on permanent errors: validation (400) and size ceilings
      // (413) will never succeed on retry.
      if (status === 400 || status === 413) throw err
      if (restart < TRANSFER_RESTARTS) {
        restart++
        onProgress({ phase: 'init', sentBytes: 0, totalBytes: file.size })
        await delay(600 * restart)
        continue
      }
      throw err
    }
  }
}

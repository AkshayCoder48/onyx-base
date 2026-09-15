import { NextRequest } from 'next/server'
import {
  findFileByPublicId,
  incrementFileDownload,
  resolveFileBotToken,
  resolveFileBotApiBaseUrl,
} from '@/lib/data-store'
import { getCachedFileDownloadUrl } from '@/lib/telegram'
import { verifyDownloadToken } from '@/lib/download-token'

export const runtime = 'nodejs'
// Downloads can take a while for large files; let the stream run up to 5 min.
export const maxDuration = 300

/**
 * CORS: these permanent file URLs are embedded/fetched cross-origin (e.g. the
 * RGE Hub app loads XML previews with Range requests, videos seek via
 * <video>). Public files get permissive CORS; the Expose-Headers list makes
 * 206/Content-Range/ETag readable by fetch() callers (XML viewer pagination).
 */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, If-None-Match, Content-Type',
  'Access-Control-Expose-Headers':
    'Content-Range, Content-Length, Accept-Ranges, ETag, Cache-Control, X-File-Name, Content-Disposition',
  'Access-Control-Max-Age': '86400',
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/**
 * GET /f/[id] — the public file-to-link proxy.
 *
 * Three serving paths:
 *
 *   1. **V5 parts mode (permanent Telegram-backed storage)** — a ready public
 *      blob whose parts live as Telegram documents is streamed part-by-part
 *      with full HTTP Range support (206 + Content-Range), ETag and HEAD —
 *      video seeking, resumable downloads and partial XML previews all work
 *      against the ONE logical file. Chunking is invisible to the client.
 *
 *   2. **V5 single-PUT mode** — a ready public blob is served directly from
 *      V5 staging (authoritative instant path).
 *
 *   3. **V4 Telegram flow** — legacy files keep working unchanged.
 *
 * Access modes (paths 2/3):
 *   1. **Permanent public link** — `/f/<fileId>` with no query string.
 *   2. **Signed time-limited link** — `/f/<fileId>?t=<sig>&e=<expiresAt>`.
 *
 * In ALL modes the actual Telegram download URL is NEVER exposed to the end
 * user. Pass `?inline=1` to render inline in the browser instead of forcing
 * a download.
 */

async function resolveV5PartsResponse(req: NextRequest, id: string): Promise<Response | null> {
  try {
    const { v5Configured } = await import('@/lib/v5/db')
    if (!v5Configured()) return null
    const { loadBlobForServe, serveBlobParts } = await import('@/lib/v5/blob-parts')
    let manifest = await loadBlobForServe(id)
    if (!manifest) {
      // Cross-instance freshness (file mode): the blob may have been
      // finalized on another instance after this one booted. One
      // rate-limited Telegram snapshot probe + retry before falling through.
      try {
        const { ensureFreshness } = await import('@/lib/v5/sync')
        await ensureFreshness()
        manifest = await loadBlobForServe(id)
      } catch {
        /* fall through */
      }
    }
    if (!manifest || !manifest.isPublic) return null
    if (manifest.status !== 'ready' || !manifest.parts || manifest.parts.length === 0) return null
    return serveBlobParts(manifest, {
      rangeHeader: req.headers.get('range'),
      ifNoneMatch: req.headers.get('if-none-match'),
      filename: manifest.filename || id,
      mimeType: manifest.mimeType || 'application/octet-stream',
      etag: manifest.checksum,
      isPublic: manifest.isPublic,
    })
  } catch {
    return null
  }
}

/** Append CORS headers to any serving response (public files are embedded cross-origin). */
function withCors(res: Response): Response {
  if (res.status === 403 || res.status === 404) return res // errors stay as-is
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v)
  return res
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withCors(await GETImpl(req, id))
}

async function GETImpl(req: NextRequest, id: string) {
  // ─── V5 parts mode: permanent Telegram-backed files (Range-aware) ─────────
  const partsResponse = await resolveV5PartsResponse(req, id)
  if (partsResponse) return partsResponse

  // ─── V5 fast path (single-PUT staging blobs) ──────────────────────────────
  // When the V5 engine is configured, a ready public blob with this id is
  // served directly from V5 staging (authoritative instant path). Falls
  // through to the V4 Telegram flow otherwise — V4 URLs keep working.
  try {
    const { v5Configured } = await import('@/lib/v5/db')
    if (v5Configured()) {
      const { getBlob, blobContentStream } = await import('@/lib/v5/blobs')
      let blob = await getBlob(id)
      if (!blob) {
        // Cross-instance freshness (file mode): the blob may have been
        // finalized on another instance after this one booted. One
        // rate-limited Telegram snapshot probe + retry before 404ing.
        try {
          const { ensureFreshness } = await import('@/lib/v5/sync')
          await ensureFreshness()
          blob = await getBlob(id)
        } catch {
          /* fall through to V4 */
        }
      }
      if (blob && blob.status === 'ready' && blob.isPublic) {
        const headers = new Headers()
        headers.set('Content-Type', blob.mimeType || 'application/octet-stream')
        const safeName = encodeURIComponent(blob.filename || id).replace(/'/g, '%27')
        const inline = req.nextUrl.searchParams.get('inline') === '1'
        headers.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"; filename*=UTF-8''${safeName}`)
        if (blob.checksum) headers.set('ETag', blob.checksum)
        headers.set('Content-Length', String(blob.size))
        if (req.headers.get('if-none-match') && req.headers.get('if-none-match') === blob.checksum) {
          return new Response(null, { status: 304, headers })
        }
        return new Response(blobContentStream(blob), { status: 200, headers })
      }
    }
  } catch {
    /* V5 unavailable → fall through to V4 */
  }

  const file = findFileByPublicId(id)
  if (!file) {
    return new Response('File not found.', { status: 404, headers: { 'Content-Type': 'text/plain' } })
  }

  // ─── Access control ──────────────────────────────────────────────────────
  const tokenParam = req.nextUrl.searchParams.get('t')
  let hasSignedAccess = false
  if (tokenParam) {
    const { valid } = verifyDownloadToken(file.fileId, tokenParam)
    hasSignedAccess = valid
  }

  if (!file.isPublic && !hasSignedAccess) {
    return new Response('This file is private. Tap "Get link" in the dashboard to mint a temporary download link.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  // Resolve the bot token that ACTUALLY HOLDS this file — based on the file's
  // `storageMode`, not the user's current config. A Telegram file_id is
  // bot-specific, so we must call getFile on the same bot that received the
  // upload (server bot for `storageMode='server'`, custom bot for `'custom'`).
  // Same for the Bot API base URL: a file uploaded via a local Bot API server
  // has a LOCAL file_id that can only be resolved by that same server.
  const botToken = resolveFileBotToken(file)
  const botApiBaseUrl = resolveFileBotApiBaseUrl(file)
  const resolved = await getCachedFileDownloadUrl(file.telegramFileId, botToken, botApiBaseUrl)
  if (!resolved) {
    return new Response('Could not resolve the file from Telegram. It may have been removed. If you are using the cloud Bot API, files over 20 MB cannot be downloaded via getFile — configure a custom local Bot API server in Settings to enable 2 GB downloads.', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  // Fetch the (cached, still-fresh) stream from Telegram.
  const upstream = await fetch(resolved.url)
  if (!upstream.ok || !upstream.body) {
    return new Response('Telegram returned an error while streaming the file.', {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  // Bump the download counter (fire-and-forget — never blocks the stream).
  incrementFileDownload(file.fileId)

  // Decide whether to render inline or force a download.
  const inline = req.nextUrl.searchParams.get('inline') === '1'
  const disposition = inline ? 'inline' : 'attachment'
  // RFC 5987 encoded filename so non-ASCII names survive intact.
  const safeName = encodeURIComponent(file.fileName).replace(/'/g, '%27')

  const headers = new Headers()
  headers.set('Content-Type', file.mimeType || 'application/octet-stream')
  headers.set('Content-Disposition', `${disposition}; filename="${safeName}"; filename*=UTF-8''${safeName}`)
  const len = resolved.fileSize ?? (upstream.headers.get('content-length') ? Number(upstream.headers.get('content-length')) : null)
  if (len != null && Number.isFinite(len)) headers.set('Content-Length', String(len))
  // Public files: cache aggressively. Signed/private files: don't cache the
  // response so a leaked URL can't be re-served past its expiry.
  headers.set('Cache-Control', file.isPublic && !hasSignedAccess ? 'public, max-age=300' : 'private, no-store')
  headers.set('X-File-Name', file.fileName)

  // Pipe the Telegram byte stream straight back to the client.
  return new Response(upstream.body as ReadableStream<Uint8Array>, {
    status: 200,
    headers,
  })
}

/**
 * HEAD /f/[id] — headers only (Content-Length, Content-Type, Accept-Ranges,
 * ETag) without transferring bytes. Used by download managers and players to
 * probe a file before ranged retrieval.
 */
export async function HEAD(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withCors(await HEADImpl(req, id))
}

async function HEADImpl(req: NextRequest, id: string) {
  // V5 parts mode: resolve metadata and answer with real headers.
  try {
    const { v5Configured } = await import('@/lib/v5/db')
    if (v5Configured()) {
      const { loadBlobForServe } = await import('@/lib/v5/blob-parts')
      let manifest = await loadBlobForServe(id)
      if (!manifest) {
        try {
          const { ensureFreshness } = await import('@/lib/v5/sync')
          await ensureFreshness()
          manifest = await loadBlobForServe(id)
        } catch {
          /* fall through */
        }
      }
      if (manifest && manifest.isPublic && manifest.status === 'ready' && manifest.parts && manifest.parts.length > 0) {
        const headers = new Headers()
        const safeName = encodeURIComponent(manifest.filename || id).replace(/'/g, '%27')
        headers.set('Content-Type', manifest.mimeType || 'application/octet-stream')
        headers.set('Content-Disposition', `inline; filename="${safeName}"; filename*=UTF-8''${safeName}`)
        headers.set('Content-Length', String(manifest.size))
        headers.set('Accept-Ranges', 'bytes')
        if (manifest.checksum) headers.set('ETag', `"${manifest.checksum}"`)
        headers.set('Cache-Control', 'public, max-age=300')
        return new Response(null, { status: 200, headers })
      }
    }
  } catch {
    /* fall through */
  }

  // Everything else: reuse GET semantics cheaply where possible.
  const probe = new NextRequest(new URL(req.url), { method: 'GET', headers: req.headers, body: null })
  const res = await GET(probe, { params: Promise.resolve({ id }) })
  const headers = new Headers()
  for (const key of ['content-type', 'content-length', 'content-disposition', 'accept-ranges', 'etag', 'cache-control', 'x-file-name']) {
    const v = res.headers.get(key)
    if (v) headers.set(key, v)
  }
  return new Response(null, { status: res.status, headers })
}

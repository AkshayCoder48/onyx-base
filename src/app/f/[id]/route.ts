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
 * GET /f/[id] — the public file-to-link proxy.
 *
 * Two access modes:
 *
 *   1. **Permanent public link** — `/f/<fileId>` with no query string.
 *      Works ONLY when the file was uploaded with `public=true`. The
 *      unguessable fileId is the credential. This link never expires.
 *
 *   2. **Signed time-limited link** — `/f/<fileId>?t=<sig>&e=<expiresAt>`.
 *      Minted by `POST /api/files/[id]/link` when the user taps "Get link".
 *      Works for BOTH public and private files. Expires after ~1 hour
 *      (matching Telegram's own getFile URL expiry), after which the user
 *      taps "Get link" again. The signature is HMAC-SHA256 over
 *      `${fileId}:${expiresAt}` — forged tokens are rejected.
 *
 * In BOTH modes the actual Telegram download URL is NEVER exposed to the end
 * user. We resolve it behind the scenes via `getCachedFileDownloadUrl`, which
 * caches the result for ~55 minutes so we don't spam Telegram's `getFile`
 * endpoint on every download. Pass `?inline=1` to render inline in the browser
 * (images, PDFs) instead of forcing a download.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
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

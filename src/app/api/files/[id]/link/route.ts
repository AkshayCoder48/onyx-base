import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import { findFileById, resolveFileBotToken, resolveFileBotApiBaseUrl, markFileLinkRevoked } from '@/lib/data-store'
import {
  getCachedFileDownloadUrl,
  invalidateCachedFileUrl,
  getCachedTelegramDirectUrl,
} from '@/lib/telegram'
import { DOWNLOAD_LINK_TTL_MS } from '@/lib/download-token'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * POST /api/files/[id]/link — mint a fresh download link for a file.
 *
 * Returns the TELEGRAM DIRECT URL (`https://api.telegram.org/file/bot<token>/<file_path>`)
 * as the primary `url` field — this is the raw cloud link pulled straight from
 * Telegram's `getFile` API. Telegram revokes this URL after ~1 hour.
 *
 * Auth: `Authorization: Bearer kv_live_…` (owner only).
 *
 * Anti-spam design (exactly as the user requested):
 *   1. The cached Telegram URL is reused for ~55 minutes (just under
 *      Telegram's 1-hour revocation). Within that window, repeated calls make
 *      ZERO Telegram API calls.
 *   2. A brand-new URL is fetched from Telegram ONLY when:
 *        - the cache is empty/stale, OR
 *        - the user passes `?force=1` (the "Refresh" button after expiry).
 *   3. The link is NEVER auto-refreshed. The user must tap the button again
 *      after the link expires.
 *
 * Query params:
 *   ?force=1  — bust the cache and pull a brand-new URL from Telegram.
 *
 * Response shape:
 *   {
 *     url:         "https://api.telegram.org/file/bot…/…",   // Telegram DIRECT
 *     proxyUrl:    "https://your-app/f/f_…",                  // signed proxy fallback
 *     expiresAt:   1735900000000,                             // epoch ms
 *     expiresInSec: 3300,
 *     revokedAble: true,
 *     file: { …file metadata }
 *   }
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const file = findFileById(user.dbUserId, id)
  if (!file) return fail('File not found.', 404)

  // ?force=1 → bust the cache so the next call hits Telegram for a brand-new URL.
  const force = req.nextUrl.searchParams.get('force') === '1'
  const botToken = resolveFileBotToken(file)
  const botApiBaseUrl = resolveFileBotApiBaseUrl(file)
  if (force) {
    invalidateCachedFileUrl(file.telegramFileId, botToken, botApiBaseUrl)
  }

  const resolved = await getCachedTelegramDirectUrl(file.telegramFileId, botToken, botApiBaseUrl)
  if (!resolved) {
    return fail(
      'Could not resolve a download URL from Telegram. The file may have been removed from the backing chat. If you are using the cloud Bot API, files over 20 MB cannot be downloaded via getFile — configure a custom local Bot API server in Settings to enable 2 GB downloads.',
      502,
    )
  }

  // Cap the link lifetime to the lower of (our 55-min default) and (the cached
  // Telegram URL's remaining lifetime), so the link never outlives the
  // underlying Telegram URL.
  const ttl = Math.min(DOWNLOAD_LINK_TTL_MS, Math.max(0, resolved.expiresAt - Date.now()))
  if (ttl <= 0) {
    return fail('The Telegram download URL expired before we could mint a link. Please try again.', 502)
  }
  const expiresAt = Date.now() + ttl

  // Also build a proxied URL on our origin (uses the same cached Telegram URL
  // under the hood — no extra Telegram call). The proxy is a fallback for
  // environments where the raw Telegram URL is blocked, and it lets us
  // continue serving public files permanently.
  const origin = getPublicOrigin(req)
  const proxyUrl = `${origin}/f/${file.fileId}`

  await logAction(user, 'file.link', undefined, `${file.fileName} (force=${force})`, 'dashboard')

  return ok({
    // The primary URL — Telegram's direct cloud link. Telegram revokes it
    // after ~1 hour. This is what the UI shows in the "Download URL" field.
    url: resolved.url,
    // The proxied URL on our origin — permanent for public files, works as a
    // fallback. NOT shown by default in the UI but available if needed.
    proxyUrl,
    expiresAt,
    /** Seconds until the link stops working — the UI shows a countdown. */
    expiresInSec: Math.floor((expiresAt - Date.now()) / 1000),
    /** Whether the cached URL can be revoked server-side via POST /revoke. */
    revocable: true,
    /** When (if ever) the user last revoked a link for this file. */
    linkRevokedAt: file.linkRevokedAt ?? null,
    file: {
      id: file.id,
      fileId: file.fileId,
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.size,
      isPublic: file.isPublic,
      storageMode: file.storageMode ?? 'server',
    },
  })
}

import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import { findFileById, resolveFileBotToken } from '@/lib/data-store'
import {
  getCachedTelegramDirectUrl,
  invalidateCachedFileUrl,
} from '@/lib/telegram'
import { DOWNLOAD_LINK_TTL_MS } from '@/lib/download-token'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * POST /v1/files/[id]/link — REST equivalent of /api/files/[id]/link.
 *
 * Returns the raw Telegram cloud download URL (api.telegram.org/file/bot…/…),
 * revoked by Telegram after ~1 hour. Cached server-side for ~55 min so
 * repeated calls don't spam Telegram. Pass ?force=1 to bypass the cache.
 *
 * Auth: `Authorization: Bearer kv_live_…` (owner only).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { id } = await params
  const file = findFileById(user.dbUserId, id)
  if (!file) return fail('File not found.', 404)

  const force = req.nextUrl.searchParams.get('force') === '1'
  if (force) {
    invalidateCachedFileUrl(file.telegramFileId, resolveFileBotToken(file))
  }

  const botToken = resolveFileBotToken(file)
  const resolved = await getCachedTelegramDirectUrl(file.telegramFileId, botToken)
  if (!resolved) {
    return fail(
      'Could not resolve a download URL from Telegram. The file may exceed the cloud Bot API 20 MB download limit (a local Bot API server is required for larger files).',
      502,
    )
  }

  const ttl = Math.min(DOWNLOAD_LINK_TTL_MS, Math.max(0, resolved.expiresAt - Date.now()))
  if (ttl <= 0) return fail('The Telegram URL expired before we could mint a link. Please try again.', 502)
  const expiresAt = Date.now() + ttl

  await logAction(user, 'file.link', undefined, `${file.fileName} (force=${force})`, 'api')

  return ok({
    url: resolved.url,
    proxyUrl: `${getPublicOrigin(req)}/f/${file.fileId}`,
    expiresAt,
    expiresInSec: Math.floor((expiresAt - Date.now()) / 1000),
    revocable: true,
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

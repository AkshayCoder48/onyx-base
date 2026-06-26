import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import {
  adminFindFileById,
  resolveFileBotToken,
  markFileLinkRevoked,
} from '@/lib/data-store'
import { getCachedTelegramDirectUrl, invalidateCachedFileUrl } from '@/lib/telegram'
import { DOWNLOAD_LINK_TTL_MS } from '@/lib/download-token'

export const runtime = 'nodejs'

/**
 * POST /api/admin/files/[id]/link
 * Auth: Bearer onyxbase_...
 *
 * Admin override: mint a Telegram DIRECT download URL for ANY user's file.
 * Works identically to /api/files/[id]/link but crosses user boundaries —
 * the admin doesn't need to own the file.
 *
 * ?force=1 busts the cache and pulls a brand-new URL from Telegram.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await authenticateAdmin(req.headers.get('authorization'))
  if (!admin) return fail('Unauthorized. Admin key required.', 401)

  const { id } = await params
  const file = adminFindFileById(id)
  if (!file) return fail('File not found.', 404)

  const force = req.nextUrl.searchParams.get('force') === '1'
  const botToken = resolveFileBotToken(file)
  if (force) {
    invalidateCachedFileUrl(file.telegramFileId, botToken)
  }

  const resolved = await getCachedTelegramDirectUrl(file.telegramFileId, botToken)
  if (!resolved) {
    return fail(
      'Could not resolve a download URL from Telegram. The file may have been removed or exceeds the 20 MB Bot API limit.',
      502,
    )
  }

  const ttl = Math.min(DOWNLOAD_LINK_TTL_MS, Math.max(0, resolved.expiresAt - Date.now()))
  if (ttl <= 0) {
    return fail('The Telegram download URL expired. Please try again.', 502)
  }
  const expiresAt = Date.now() + ttl

  return ok({
    url: resolved.url,
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

/**
 * DELETE /api/admin/files/[id]/link
 * Auth: Bearer onyxbase_...
 *
 * Admin override: revoke (drop the cached Telegram URL) for ANY user's file.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const admin = await authenticateAdmin(req.headers.get('authorization'))
  if (!admin) return fail('Unauthorized. Admin key required.', 401)

  const { id } = await params
  const file = adminFindFileById(id)
  if (!file) return fail('File not found.', 404)

  invalidateCachedFileUrl(file.telegramFileId, resolveFileBotToken(file))
  markFileLinkRevoked(file.userId, file.id)
  return ok({ revoked: true })
}

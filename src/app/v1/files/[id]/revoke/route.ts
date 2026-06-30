import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { findFileById, resolveFileBotToken, markFileLinkRevoked } from '@/lib/data-store'
import { invalidateCachedFileUrl } from '@/lib/telegram'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * POST /v1/files/[id]/revoke — REST equivalent of /api/files/[id]/revoke.
 *
 * Drops the cached Telegram URL and marks the file's link as revoked. The
 * next /link call will mint a brand-new URL from Telegram.
 *
 * Auth: `Authorization: Bearer kv_live_…` (owner only).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(user, req, { scope: 'files' })
  if (!z.ok) return authorizeFailResponse(z)

  const { id } = await params
  const file = findFileById(user.dbUserId, id)
  if (!file) return fail('File not found.', 404)

  invalidateCachedFileUrl(file.telegramFileId, resolveFileBotToken(file))
  const updated = markFileLinkRevoked(user.dbUserId, id)

  await logAction(user, 'file.revoke', undefined, `${file.fileName}`, 'api')

  return ok({
    revoked: true,
    id,
    linkRevokedAt: updated?.linkRevokedAt ?? null,
    note: 'Cached download URL dropped. The next /link call mints a fresh URL from Telegram.',
  })
}

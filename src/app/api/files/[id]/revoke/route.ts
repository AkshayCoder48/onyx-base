import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { findFileById, resolveFileBotToken, markFileLinkRevoked } from '@/lib/data-store'
import { invalidateCachedFileUrl } from '@/lib/telegram'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * POST /api/files/[id]/revoke — revoke the current Telegram download link.
 *
 * WHAT THIS DOES:
 *   1. Drops our server-side cache for the file's current Telegram URL, so we
 *      never re-serve or re-proxy it.
 *   2. Records `linkRevokedAt = now` on the file record so the UI can show
 *      "link revoked at HH:MM:SS" and the user knows a new link must be
 *      minted.
 *
 * WHAT THIS DOES NOT DO:
 *   Telegram's `getFile` URLs CANNOT be manually revoked before their natural
 *   ~1-hour expiry — that's a server-side Telegram timer we have no control
 *   over. So the OLD URL technically remains reachable until Telegram's own
 *   timer runs out. But after /revoke:
 *     - We no longer cache or re-serve it,
 *     - The next "Get link" call mints a BRAND-NEW URL (fresh `getFile`),
 *     - The UI shows the file as "revoked".
 *
 * Auth: `Authorization: Bearer kv_live_…` (owner only).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const file = findFileById(user.dbUserId, id)
  if (!file) return fail('File not found.', 404)

  // Drop the cached Telegram URL so we never re-serve it.
  invalidateCachedFileUrl(file.telegramFileId, resolveFileBotToken(file))

  // Mark the file's link as revoked (records the timestamp on the record).
  const updated = markFileLinkRevoked(user.dbUserId, id)

  await logAction(user, 'file.revoke', undefined, `${file.fileName}`, 'dashboard')

  return ok({
    revoked: true,
    id,
    linkRevokedAt: updated?.linkRevokedAt ?? null,
    /** Friendly reminder: Telegram's own URL remains valid until its natural expiry. */
    note: 'The cached download URL has been dropped. The next "Get link" call will mint a brand-new URL from Telegram. Note: Telegram revokes getFile URLs after ~1 hour on its own — we cannot force an earlier revoke on Telegram\'s side.',
  })
}

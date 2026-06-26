import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { revokeShareToken, resolveChatId } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** DELETE /api/dashboard/share-tokens/[id] — revoke a public share token. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const revoked = revokeShareToken(user.dbUserId, id)
  if (!revoked) return fail('Share token not found.', 404)

  await logAction(
    user,
    'share.revoke',
    revoked.key,
    `mode=${revoked.mode} collection=${revoked.collection}`,
    'dashboard',
  )

  void sendEventMessage(
    {
      owner: user.userId,
      event: 'share.revoke',
      detail: `${revoked.mode} · ${revoked.collection}/${revoked.key}`,
      source: 'dashboard',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.dbUserId),
  )

  return ok({ revoked: true, id: revoked.id })
}

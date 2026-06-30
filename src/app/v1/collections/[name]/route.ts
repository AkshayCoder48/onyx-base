import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { deleteCollection, resolveChatId } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * DELETE /v1/collections/[name] — delete a collection and all its records.
 *
 * Auth: `Authorization: Bearer kv_live_…`
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await params

  const z = authorize(user, req, { scope: 'collections', collection: name })
  if (!z.ok) return authorizeFailResponse(z)

  if (name === 'default') return fail('The default collection cannot be deleted.', 400)

  const chatId = resolveChatId(user.dbUserId)
  const removed = deleteCollection(user.dbUserId, name, chatId)
  if (removed === null) return fail('Collection not found.', 404)

  await logAction(user, 'collection.delete', undefined, `name=${name}`, 'api')
  void sendEventMessage(
    {
      owner: user.userId,
      event: 'collection.delete',
      detail: `name=${name} (${removed} records)`,
      source: 'api',
      ts: Math.floor(Date.now() / 1000),
    },
    chatId,
  )
  return ok({ deleted: true, removed })
}

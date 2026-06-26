import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { revokeApiKey } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** DELETE /api/dashboard/api-keys/[id] — revoke an API key. */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const apiKey = revokeApiKey(user.dbUserId, id)
  if (!apiKey) return fail('API key not found.', 404)

  await logAction(user, 'apikey.revoke', undefined, `name=${apiKey.name}`, 'dashboard')
  void sendEventMessage({
    owner: user.userId,
    event: 'apikey.revoke',
    detail: `name=${apiKey.name}`,
    source: 'dashboard',
    ts: Math.floor(Date.now() / 1000),
  })
  return ok({ revoked: true })
}

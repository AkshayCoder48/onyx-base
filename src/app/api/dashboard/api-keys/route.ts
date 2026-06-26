import { NextRequest } from 'next/server'
import { authenticate, ok, fail, generateApiKey } from '@/lib/auth'
import { listApiKeys, createApiKey, resolveChatId } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** GET /api/dashboard/api-keys — list the developer's API keys. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const keys = listApiKeys(user.dbUserId)
  return ok({
    apiKeys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      key: k.key,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revoked: k.revoked,
    })),
  })
}

/** POST /api/dashboard/api-keys — mint a new API key. Body: { "name": "Production" } */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))
  const name = (body.name as string) || 'new-key'
  const created = createApiKey(user.dbUserId, name)
  await logAction(user, 'apikey.create', undefined, `name=${name}`, 'dashboard')
  void sendEventMessage(
    {
      owner: user.userId,
      event: 'apikey.create',
      detail: `name=${name}`,
      source: 'dashboard',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.dbUserId),
  )
  return ok({
    apiKey: {
      id: created.id,
      name: created.name,
      key: created.key,
      createdAt: created.createdAt,
      lastUsedAt: created.lastUsedAt,
      revoked: created.revoked,
    },
  })
}

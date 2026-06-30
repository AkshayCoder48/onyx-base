import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { listCollections, createCollectionName, resolveChatId } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * GET /v1/collections — list collections (with record counts).
 * POST /v1/collections — create a collection. Body: { "name": "cache" }
 *
 * Auth: `Authorization: Bearer kv_live_…`
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(user, req, { scope: 'collections' })
  if (!z.ok) return authorizeFailResponse(z)

  const collections = listCollections(user.dbUserId)
  return ok({
    collections: collections.map((c) => ({
      id: c.name,
      name: c.name,
      records: c.records,
      createdAt: c.createdAt,
    })),
    count: collections.length,
  })
}

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const body = await req.json().catch(() => ({}))
  const name = (body.name as string)?.trim()
  if (!name) return fail('Collection name is required.', 400)

  const z = authorize(user, req, {
    scope: 'collections',
    collection: name,
    bytesWritten: Buffer.byteLength(JSON.stringify(body)),
  })
  if (!z.ok) return authorizeFailResponse(z)

  const result = createCollectionName(user.dbUserId, name)
  if (!result.ok) return fail(result.error, 400)

  await logAction(user, 'collection.create', undefined, `name=${name}`, 'api')
  void sendEventMessage(
    {
      owner: user.userId,
      event: 'collection.create',
      detail: `name=${name}`,
      source: 'api',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.dbUserId),
  )
  return ok({ collection: { id: name, name } })
}

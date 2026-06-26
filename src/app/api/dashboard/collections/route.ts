import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { listCollections, createCollectionName, resolveChatId } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** GET /api/dashboard/collections — list collections with record counts. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const collections = listCollections(user.dbUserId)
  return ok({
    collections: collections.map((c) => ({
      id: c.name, // collections are derived; use name as id
      name: c.name,
      records: c.records,
      createdAt: c.createdAt,
    })),
  })
}

/** POST /api/dashboard/collections — create a collection. Body: { "name": "cache" }
 *
 * Persists the collection name so it shows up in the dashboard and the
 * record-creation dropdown even before any records are written to it.
 * Idempotent: re-creating an existing collection is a no-op success.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))
  const name = (body.name as string)?.trim()
  if (!name) return fail('Collection name is required.', 400)

  const result = createCollectionName(user.dbUserId, name)
  if (!result.ok) return fail(result.error, 400)

  await logAction(user, 'collection.create', undefined, `name=${name}`, 'dashboard')
  void sendEventMessage(
    {
      owner: user.userId,
      event: 'collection.create',
      detail: `name=${name}`,
      source: 'dashboard',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.dbUserId),
  )
  return ok({ collection: { id: name, name } })
}

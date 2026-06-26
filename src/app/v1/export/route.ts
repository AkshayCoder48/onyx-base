import { NextRequest } from 'next/server'
import { authenticate, fail, ok } from '@/lib/auth'
import { exportData, logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * GET /v1/export?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Returns the full database as a JSON object:
 * { "coins": 500, "theme": "dark", "premium": true, "users.score": 42 }
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const collection = req.nextUrl.searchParams.get('collection') || undefined
  const data = await exportData(user, collection)
  await logAction(user, 'export', undefined, collection ? `collection=${collection}` : 'all', 'api')
  void sendEventMessage({
    owner: user.userId,
    event: 'export',
    detail: collection ? `collection=${collection}` : 'all',
    source: 'api',
    ts: Math.floor(Date.now() / 1000),
  })
  return ok({ data })
}

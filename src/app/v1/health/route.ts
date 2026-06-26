import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { countRecords, countCollections } from '@/lib/data-store'
import { pingTelegram } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * GET /v1/health
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Returns service + storage status for the authenticated developer.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const [recordCount, collectionCount, telegram] = await Promise.all([
    Promise.resolve(countRecords(user.dbUserId)),
    Promise.resolve(countCollections(user.dbUserId)),
    pingTelegram(),
  ])

  return ok({
    status: 'ok',
    user: user.userId,
    storage: {
      engine: 'telegram',
      records: recordCount,
      collections: collectionCount,
    },
    telegram: {
      configured: telegram.ok,
      reachable: telegram.ok,
      bot: telegram.botName ?? null,
      chatId: telegram.chatId,
      chatType: telegram.chatType ?? null,
      error: telegram.error ?? null,
    },
  })
}

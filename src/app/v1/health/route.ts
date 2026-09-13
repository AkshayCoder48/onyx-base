import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, ok } from '@/lib/auth'
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
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  const [recordCount, collectionCount, telegram] = await Promise.all([
    Promise.resolve(countRecords(user.dbUserId)),
    Promise.resolve(countCollections(user.dbUserId)),
    pingTelegram(),
  ])

  return ok({
    status: 'ok',
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    user: user.userId,
    storage: {
      engine: 'telegram',
      records: recordCount,
      collections: collectionCount,
    },
    telegram: {
      configured: telegram.ok,
      reachable: telegram.ok,
      chatType: telegram.chatType ?? null,
      error: telegram.error ?? null,
    },
  })
}

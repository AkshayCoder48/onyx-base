import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { findUserByDbId, countRecords, countCollections, listApiKeys, countLogs } from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * POST /api/auth/verify
 * Body: { "apiKey": "kv_live_xxx" }  OR  Authorization: Bearer kv_live_xxx
 *
 * Used by the dashboard login screen. Returns the developer's identity + a
 * summary that the dashboard needs to render the shell.
 */
export async function POST(req: NextRequest) {
  const headerAuth = req.headers.get('authorization')
  let apiKey: string | undefined

  if (headerAuth && /^Bearer\s+/i.test(headerAuth)) {
    apiKey = headerAuth.replace(/^Bearer\s+/i, '').trim()
  } else {
    try {
      const body = await req.json()
      apiKey = (body.apiKey as string)?.trim()
    } catch {
      /* ignore */
    }
  }

  if (!apiKey) return fail('API key is required.', 400)

  const user = await authenticate(`Bearer ${apiKey}`)
  if (!user) return fail('Invalid, revoked, or unknown API key.', 401)

  const dbUser = findUserByDbId(user.dbUserId)

  await logAction(user, 'login', undefined, 'dashboard session started', 'dashboard')

  // Mirror the login event to the Telegram backup channel.
  void sendEventMessage({
    owner: user.userId,
    event: 'login',
    detail: `key=${user.apiKeyName}`,
    source: 'dashboard',
    ts: Math.floor(Date.now() / 1000),
  })

  return ok({
    userId: user.userId,
    name: dbUser?.name ?? null,
    plan: dbUser?.plan ?? 'unlimited',
    apiKeyName: user.apiKeyName,
    createdAt: dbUser?.createdAt,
    counts: {
      records: countRecords(user.dbUserId),
      collections: countCollections(user.dbUserId),
      apiKeys: listApiKeys(user.dbUserId).filter((k) => !k.revoked).length,
      logs: countLogs(user.dbUserId),
    },
  })
}

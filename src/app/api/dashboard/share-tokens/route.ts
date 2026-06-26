import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import {
  listShareTokens,
  createShareToken,
  publicShareTokenView,
  resolveChatId,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** GET /api/dashboard/share-tokens — list the developer's public share tokens. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const origin = getPublicOrigin(req)
  const tokens = listShareTokens(user.dbUserId).map((t) =>
    publicShareTokenView(t, origin),
  )
  return ok({ shareTokens: tokens })
}

/**
 * POST /api/dashboard/share-tokens — mint a new public share token.
 *
 * Body:
 *   {
 *     "collection": "default",          // optional, defaults to "default"
 *     "key": "leaderboard",             // required — the key this token exposes
 *     "mode": "read" | "write" | "readwrite",
 *     "label": "Public leaderboard", // optional
 *     "ttlMinutes": 60,                 // optional, null/0 = never
 *     "rateLimitPerMin": 30,            // optional, null = unlimited
 *     "allowedOps": ["set","incr","append"],  // for write modes
 *     "maxValueLength": 4096,           // optional, for write
 *     "incrMin": 0, "incrMax": null     // optional, for incr
 *   }
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))

  const collection =
    (typeof body.collection === 'string' && body.collection.trim()) || 'default'
  const key = typeof body.key === 'string' ? body.key.trim() : ''
  if (!key) return fail('`key` is required.', 400)

  const mode = body.mode === 'write' || body.mode === 'readwrite' ? body.mode : 'read'

  const label =
    typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null

  const ttlMinutes =
    typeof body.ttlMinutes === 'number' && body.ttlMinutes > 0
      ? body.ttlMinutes
      : null
  const rateLimitPerMin =
    typeof body.rateLimitPerMin === 'number' && body.rateLimitPerMin > 0
      ? Math.floor(body.rateLimitPerMin)
      : null

  // Parse allowedOps for write modes.
  let allowedOps: ('set' | 'incr' | 'append')[] = ['set', 'incr', 'append']
  if (Array.isArray(body.allowedOps) && body.allowedOps.length > 0) {
    const filtered = (body.allowedOps as string[]).filter(
      (o) => o === 'set' || o === 'incr' || o === 'append',
    ) as ('set' | 'incr' | 'append')[]
    if (filtered.length > 0) allowedOps = filtered
  }

  const maxValueLength =
    typeof body.maxValueLength === 'number' && body.maxValueLength > 0
      ? Math.floor(body.maxValueLength)
      : null
  const incrMin = typeof body.incrMin === 'number' ? body.incrMin : null
  const incrMax = typeof body.incrMax === 'number' ? body.incrMax : null

  const created = createShareToken({
    dbUserId: user.dbUserId,
    collection,
    key,
    mode,
    label,
    ttlMinutes,
    rateLimitPerMin,
    allowedOps,
    maxValueLength,
    incrMin,
    incrMax,
  })

  await logAction(
    user,
    'share.create',
    key,
    `mode=${mode} collection=${collection}${rateLimitPerMin ? ` limit=${rateLimitPerMin}/min` : ''}${ttlMinutes ? ` ttl=${ttlMinutes}m` : ''}`,
    'dashboard',
  )

  void sendEventMessage(
    {
      owner: user.userId,
      event: 'share.create',
      detail: `${mode} · ${collection}/${key}${label ? ` · ${label}` : ''}`,
      source: 'dashboard',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.dbUserId),
  )

  return ok({
    shareToken: publicShareTokenView(created, getPublicOrigin(req)),
  })
}

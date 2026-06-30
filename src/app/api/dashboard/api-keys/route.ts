import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import {
  listApiKeys,
  createApiKey,
  resolveChatId,
  type ApiKeyScope,
  type ApiKeyOpts,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/** Shape returned to the dashboard (everything except the raw key on reads). */
function apiKeyToView(k: ReturnType<typeof listApiKeys>[number]) {
  return {
    id: k.id,
    name: k.name,
    key: k.key,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    revoked: k.revoked,
    // Defensively default v3 fields — old keys created before scopes existed
    // (or loaded from a v2 manifest) may have these as undefined.
    scopes: Array.isArray(k.scopes) ? k.scopes : [],
    expiresAt: k.expiresAt ?? null,
    collectionAllowList: Array.isArray(k.collectionAllowList) ? k.collectionAllowList : [],
    tableAllowList: Array.isArray(k.tableAllowList) ? k.tableAllowList : [],
    rateLimitPerMin: k.rateLimitPerMin ?? null,
    rateLimitMbPerDay: k.rateLimitMbPerDay ?? null,
  }
}

/** GET /api/dashboard/api-keys — list the developer's API keys. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const keys = listApiKeys(user.dbUserId)
  return ok({ apiKeys: keys.map(apiKeyToView) })
}

/**
 * POST /api/dashboard/api-keys — mint a new API key.
 *
 * Body:
 *   name: string                       (required)
 *   scopes?: ApiKeyScope[]             (empty/omitted = full access)
 *   expiresAt?: string | null          (ISO timestamp, null = never)
 *   collectionAllowList?: string[]     (empty = all)
 *   tableAllowList?: string[]          (empty = all)
 *   rateLimitPerMin?: number | null    (null/0 = unlimited)
 *   rateLimitMbPerDay?: number | null  (null/0 = unlimited)
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))
  const name = (body.name as string) || 'new-key'

  const opts: ApiKeyOpts = {
    scopes: Array.isArray(body.scopes) ? (body.scopes as ApiKeyScope[]) : undefined,
    expiresAt: body.expiresAt === null ? null : (body.expiresAt as string | undefined),
    collectionAllowList: Array.isArray(body.collectionAllowList) ? body.collectionAllowList : undefined,
    tableAllowList: Array.isArray(body.tableAllowList) ? body.tableAllowList : undefined,
    rateLimitPerMin: body.rateLimitPerMin === null ? null : (body.rateLimitPerMin as number | undefined),
    rateLimitMbPerDay: body.rateLimitMbPerDay === null ? null : (body.rateLimitMbPerDay as number | undefined),
  }

  const created = createApiKey(user.dbUserId, name, opts)
  await logAction(user, 'apikey.create', undefined, `name=${name} scopes=${created.scopes.join(',') || '*'}`, 'dashboard')
  void sendEventMessage(
    {
      owner: user.userId,
      event: 'apikey.create',
      detail: `name=${name} scopes=${created.scopes.join(',') || '*'}`,
      source: 'dashboard',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.dbUserId),
  )
  return ok({ apiKey: apiKeyToView(created) })
}

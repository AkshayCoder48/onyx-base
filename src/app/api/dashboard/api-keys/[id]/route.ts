import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import {
  revokeApiKey,
  updateApiKey,
  type ApiKeyScope,
  type ApiKeyOpts,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * PATCH /api/dashboard/api-keys/[id] — update an existing API key's
 * restrictions (scopes, expiry, allowlists, rate limits). Any field omitted
 * from the body is left unchanged; pass `null` explicitly to clear a field.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const body = await req.json().catch(() => ({}))

  const opts: Partial<ApiKeyOpts> = {}
  if (Array.isArray(body.scopes)) opts.scopes = body.scopes as ApiKeyScope[]
  if (body.expiresAt !== undefined) opts.expiresAt = body.expiresAt as string | null
  if (Array.isArray(body.collectionAllowList)) opts.collectionAllowList = body.collectionAllowList as string[]
  if (Array.isArray(body.tableAllowList)) opts.tableAllowList = body.tableAllowList as string[]
  if (body.rateLimitPerMin !== undefined) opts.rateLimitPerMin = body.rateLimitPerMin as number | null
  if (body.rateLimitMbPerDay !== undefined) opts.rateLimitMbPerDay = body.rateLimitMbPerDay as number | null

  const updated = updateApiKey(user.dbUserId, id, opts)
  if (!updated) return fail('API key not found.', 404)

  await logAction(user, 'apikey.update', undefined, `name=${updated.name}`, 'dashboard')
  void sendEventMessage({
    owner: user.userId,
    event: 'apikey.update',
    detail: `name=${updated.name}`,
    source: 'dashboard',
    ts: Math.floor(Date.now() / 1000),
  })

  return ok({
    apiKey: {
      id: updated.id,
      name: updated.name,
      key: updated.key,
      createdAt: updated.createdAt,
      lastUsedAt: updated.lastUsedAt,
      revoked: updated.revoked,
      scopes: Array.isArray(updated.scopes) ? updated.scopes : [],
      expiresAt: updated.expiresAt ?? null,
      collectionAllowList: Array.isArray(updated.collectionAllowList) ? updated.collectionAllowList : [],
      tableAllowList: Array.isArray(updated.tableAllowList) ? updated.tableAllowList : [],
      rateLimitPerMin: updated.rateLimitPerMin ?? null,
      rateLimitMbPerDay: updated.rateLimitMbPerDay ?? null,
    },
  })
}

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

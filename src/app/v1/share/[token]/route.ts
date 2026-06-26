import { NextRequest } from 'next/server'
import { fail, ok } from '@/lib/auth'
import {
  resolveShareToken,
  findRecord,
  addLog,
  findUserByDbId,
} from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /v1/share/[token]
 *
 * PUBLIC, unauthenticated read endpoint designed to be safe to call from
 * public HTML (CodePen, static sites, browser extensions).
 *
 * The token in the URL is a scoped, revocable share token — NOT the owner's
 * master API key. It is bound to exactly one (collection, key) pair and a
 * `read` / `readwrite` mode. Leaking it only exposes that single value; the
 * owner can revoke or rotate it instantly from the dashboard.
 *
 * Rate-limited per IP (configured per token). Optionally time-limited (TTL).
 *
 * Response: { ok, key, value, type, collection, updatedAt }
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'

  const resolved = resolveShareToken(token, ip, 'read')
  if (!resolved.ok) {
    return fail(resolved.reason, resolved.status)
  }
  const rec = resolved.record

  const record = findRecord(rec.userId, rec.collection, rec.key)
  if (!record) {
    // The token is valid but the underlying key was deleted. Return null value
    // rather than 404 so public consumers don't crash — they can detect null.
    return ok({
      key: rec.key,
      value: null,
      type: 'null',
      collection: rec.collection,
      updatedAt: null,
      note: 'Key does not exist yet.',
    })
  }

  let parsed: unknown = record.value
  try {
    parsed = JSON.parse(record.value)
  } catch {
    /* keep raw string */
  }

  // Log the public access against the owner's account (source: 'share').
  try {
    addLog({
      dbUserId: rec.userId,
      action: 'share_read',
      key: rec.key,
      detail: `collection=${rec.collection} ip=${ip} token=${rec.token.slice(0, 10)}…`,
      source: 'share',
      ip,
    })
  } catch {
    /* best-effort */
  }

  return ok({
    key: record.key,
    value: parsed,
    type: record.valueType,
    collection: record.collection,
    updatedAt: record.updatedAt,
  })
}

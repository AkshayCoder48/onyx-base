import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * GET  /api/v1/views          → list the caller's views
 * POST /api/v1/views          → create a view
 *   Body { name, collection, projection, filter? }
 *
 * Auth: Bearer kv_live_xxx
 *
 * A "view" stores a named query: { collection, projection (columns),
 * filter (WHERE clause) }. Executing it (GET /api/v1/views/[name]) returns
 * the matching records.
 *
 * The `projection` is a comma-separated column list:
 *   key, value, valueType, collection, createdAt, updatedAt
 *   or "*" for all.
 *
 * The `filter` is a string applied as a substring match on key (best-effort,
 * safe — we don't run user-supplied SQL).
 */

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/
const COL_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const rows = await db.view.findMany({
    where: { userId: user.dbUserId },
    orderBy: { name: 'asc' },
  })
  return ok({
    views: rows.map((v) => ({
      id: v.id,
      name: v.name,
      collection: v.collection,
      projection: v.projection,
      filter: v.filter,
      createdAt: v.createdAt,
    })),
    count: rows.length,
  })
}

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const body = await req.json().catch(() => null)
  if (!body) return fail('JSON body required.', 400)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const collection = typeof body.collection === 'string' ? body.collection.trim() : ''
  const projection =
    typeof body.projection === 'string' ? body.projection.trim() : '*'
  const filter =
    typeof body.filter === 'string' && body.filter.trim()
      ? body.filter.trim()
      : null

  if (!NAME_RE.test(name)) {
    return fail('`name` must start with a letter and contain only [A-Za-z0-9_-], max 64 chars.', 400)
  }
  if (!COL_RE.test(collection)) {
    return fail('`collection` must start with a letter and contain only [A-Za-z0-9_-], max 64 chars.', 400)
  }
  if (!projection) {
    return fail('`projection` is required (use "*" for all columns).', 400)
  }

  // Validate the projection is a known column list.
  const KNOWN_COLS = ['key', 'value', 'valueType', 'collection', 'createdAt', 'updatedAt']
  const requestedCols =
    projection === '*' ? KNOWN_COLS : projection.split(',').map((c) => c.trim()).filter(Boolean)
  for (const c of requestedCols) {
    if (!KNOWN_COLS.includes(c)) {
      return fail(
        `Unknown column "${c}" in projection. Valid: ${KNOWN_COLS.join(', ')} (or "*").`,
        400,
      )
    }
  }

  try {
    const created = await db.view.create({
      data: {
        userId: user.dbUserId,
        name,
        collection,
        projection,
        filter,
      },
    })
    return ok({
      view: {
        id: created.id,
        name: created.name,
        collection: created.collection,
        projection: created.projection,
        filter: created.filter,
        createdAt: created.createdAt,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Unique constraint')) {
      return fail(`View "${name}" already exists. Use a different name or DELETE it first.`, 409)
    }
    return fail(`Failed to create view: ${msg}`, 500)
  }
}

import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'
import { runUserSelect } from '@/lib/sql-engine'

export const runtime = 'nodejs'

/**
 * GET    /api/v1/matviews/{name}  → read the cached result (O(1))
 * POST   /api/v1/matviews/{name}  → refresh (re-run the query + recache)
 * DELETE /api/v1/matviews/{name}  → delete the matview
 *
 * Auth: Bearer kv_live_xxx
 */

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  const m = await db.materializedView.findUnique({
    where: { userId_name: { userId: user.dbUserId, name } },
  })
  if (!m) return fail(`Matview "${name}" not found.`, 404)

  let parsed: unknown = null
  try {
    parsed = JSON.parse(m.result)
  } catch {
    /* leave null */
  }
  return ok({
    matview: {
      name: m.name,
      query: m.query,
      lastRefreshedAt: m.lastRefreshedAt,
      createdAt: m.createdAt,
    },
    result: parsed,
  })
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  const m = await db.materializedView.findUnique({
    where: { userId_name: { userId: user.dbUserId, name } },
  })
  if (!m) return fail(`Matview "${name}" not found.`, 404)

  let result: unknown[]
  let count: number
  try {
    const res = await runUserSelect(m.query, user.userId)
    result = res.rows
    count = res.count
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Refresh failed: ${msg}`, 400, { matview: name })
  }

  const updated = await db.materializedView.update({
    where: { id: m.id },
    data: {
      result: JSON.stringify(result),
      lastRefreshedAt: new Date(),
    },
  })
  return ok({
    matview: updated.name,
    refreshedAt: updated.lastRefreshedAt,
    rowsCached: count,
    result,
  })
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  try {
    const deleted = await db.materializedView.delete({
      where: { userId_name: { userId: user.dbUserId, name } },
    })
    return ok({ action: 'delete', name: deleted.name })
  } catch {
    return fail(`Matview "${name}" not found.`, 404)
  }
}

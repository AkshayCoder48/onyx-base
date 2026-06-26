import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'
import { runUserSelect } from '@/lib/sql-engine'

export const runtime = 'nodejs'

/**
 * GET  /api/v1/matviews       → list the caller's materialized views
 * POST /api/v1/matviews       → create a matview AND compute the cached result
 *   Body { name, query }                       → create + compute
 *   Body { action: 'refresh_all' }             → refresh every matview
 *
 * Auth: Bearer kv_live_xxx
 *
 * A materialised view stores a SELECT query and the JSON-encoded result of
 * running it. Reading is O(1) — no query execution at read time. Refresh
 * re-runs the query and overwrites the cached result.
 */

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const rows = await db.materializedView.findMany({
    where: { userId: user.dbUserId },
    orderBy: { name: 'asc' },
  })
  return ok({
    matviews: rows.map((m) => ({
      id: m.id,
      name: m.name,
      query: m.query,
      lastRefreshedAt: m.lastRefreshedAt,
      createdAt: m.createdAt,
      resultBytes: m.result.length,
    })),
    count: rows.length,
  })
}

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const body = await req.json().catch(() => null)
  if (!body) return fail('JSON body required.', 400)

  // refresh-all mode
  if (body.action === 'refresh_all') {
    const all = await db.materializedView.findMany({
      where: { userId: user.dbUserId },
    })
    const results: Array<{ name: string; ok: boolean; error?: string; rows: number }> = []
    for (const m of all) {
      try {
        const res = await runUserSelect(m.query, user.userId)
        await db.materializedView.update({
          where: { id: m.id },
          data: {
            result: JSON.stringify(res.rows),
            lastRefreshedAt: new Date(),
          },
        })
        results.push({ name: m.name, ok: true, rows: res.count })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        results.push({ name: m.name, ok: false, error: msg, rows: 0 })
      }
    }
    return ok({ action: 'refresh_all', refreshed: results })
  }

  // create mode
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const query = typeof body.query === 'string' ? body.query : ''

  if (!NAME_RE.test(name)) {
    return fail('`name` must start with a letter and contain only [A-Za-z0-9_-], max 64 chars.', 400)
  }
  if (!query.trim()) {
    return fail('`query` (non-empty SELECT) is required.', 400)
  }
  if (query.length > 16 * 1024) {
    return fail('`query` is too large (max 16 KB).', 400)
  }

  // Compile + run the query now so we cache the result on create.
  let result: unknown[]
  let count: number
  try {
    const res = await runUserSelect(query, user.userId)
    result = res.rows
    count = res.count
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Query failed (not stored): ${msg}`, 400)
  }

  try {
    const created = await db.materializedView.create({
      data: {
        userId: user.dbUserId,
        name,
        query,
        result: JSON.stringify(result),
        lastRefreshedAt: new Date(),
      },
    })
    return ok({
      matview: {
        id: created.id,
        name: created.name,
        query: created.query,
        lastRefreshedAt: created.lastRefreshedAt,
        createdAt: created.createdAt,
      },
      rowsCached: count,
      result,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Unique constraint')) {
      return fail(`Matview "${name}" already exists. Use a different name or DELETE it first.`, 409)
    }
    return fail(`Failed to create matview: ${msg}`, 500)
  }
}

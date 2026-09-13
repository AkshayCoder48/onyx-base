import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'
import { listRecords } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET    /api/v1/views/{name}  → execute the view (run the projection)
 * DELETE /api/v1/views/{name}  → delete the view
 *
 * Executing a view:
 *   1. Load the view definition.
 *   2. Fetch the user's records in `collection` (user-scoped via data-store).
 *   3. If `filter` is set, keep only records whose `key` contains it as a
 *      substring (case-insensitive). This is a safe best-effort filter —
 *      we do NOT run user-supplied SQL.
 *   4. Project the requested columns.
 *
 * Auth: Bearer kv_live_xxx
 */

const KNOWN_COLS = ['key', 'value', 'valueType', 'collection', 'createdAt', 'updatedAt']

interface RecordRow {
  key: string
  value: string
  valueType: string
  collection: string
  createdAt: string
  updatedAt: string
}

function projectRow(r: RecordRow, cols: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const c of cols) {
    switch (c) {
      case 'key':
        out.key = r.key
        break
      case 'value': {
        let parsed: unknown = r.value
        try {
          parsed = JSON.parse(r.value)
        } catch {
          /* keep raw */
        }
        out.value = parsed
        break
      }
      case 'valueType':
        out.valueType = r.valueType
        break
      case 'collection':
        out.collection = r.collection
        break
      case 'createdAt':
        out.createdAt = r.createdAt
        break
      case 'updatedAt':
        out.updatedAt = r.updatedAt
        break
    }
  }
  return out
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  const view = await db.view.findUnique({
    where: { userId_name: { userId: user.dbUserId, name } },
  })
  if (!view) return fail(`View "${name}" not found.`, 404)

  const cols =
    view.projection === '*'
      ? KNOWN_COLS
      : view.projection.split(',').map((c) => c.trim()).filter(Boolean)

  // Fetch the user's records in this collection.
  const rows = listRecords(user.dbUserId, view.collection) as RecordRow[]

  // Apply the safe substring filter on `key` (case-insensitive).
  const filterLower = view.filter ? view.filter.toLowerCase() : null
  const filtered = filterLower
    ? rows.filter((r) => r.key.toLowerCase().includes(filterLower))
    : rows

  const projected = filtered.map((r) => projectRow(r, cols))
  return ok({
    view: {
      name: view.name,
      collection: view.collection,
      projection: view.projection,
      filter: view.filter,
    },
    rows: projected,
    count: projected.length,
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
    const deleted = await db.view.delete({
      where: { userId_name: { userId: user.dbUserId, name } },
    })
    return ok({ action: 'delete', name: deleted.name })
  } catch {
    return fail(`View "${name}" not found.`, 404)
  }
}

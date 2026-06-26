import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { listKeys, setKey, deleteKey } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/records?collection=&q=
 * Returns all records for the authenticated developer, optionally filtered.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const collection = req.nextUrl.searchParams.get('collection') || undefined
  const q = req.nextUrl.searchParams.get('q')?.toLowerCase() || ''
  let records = await listKeys(user, collection)
  if (q) {
    records = records.filter((r) => r.key.toLowerCase().includes(q) || JSON.stringify(r.value).toLowerCase().includes(q))
  }
  return ok({ records, count: records.length })
}

/**
 * POST /api/dashboard/records
 * Body: { "key", "value", "collection"?, "type"? }
 * Upserts a record from the dashboard UI.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => null)
  if (!body || typeof body.key !== 'string' || !body.key.trim()) {
    return fail('`key` is required.', 400)
  }
  if (body.value === undefined) return fail('`value` is required.', 400)

  const record = await setKey(user, {
    key: body.key,
    collection: body.collection || 'default',
    source: 'dashboard',
    json: body.value,
  })
  return ok({ record })
}

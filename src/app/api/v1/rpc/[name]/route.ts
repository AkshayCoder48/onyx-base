import { NextRequest } from 'next/server'
import { authenticate, coerceValue, ok, fail, type AuthenticatedUser } from '@/lib/auth'
import { setKey } from '@/lib/kv'
import {
  listRecords,
  listCollections,
  countRecords,
} from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /api/v1/rpc/{name}
 * Auth: Bearer kv_live_xxx
 *
 * Built-in RPC functions, callable by name. Mirrors the Supabase
 * `rpc/<function_name>` pattern but with a fixed set of built-ins
 * (no user-defined functions here — those live at /api/v1/functions).
 *
 * Implemented:
 *   - count_records          → { count: number }
 *   - sum           { key }  → { key, sum, count }     (sums numeric values of one key across collections)
 *   - aggregate     { collection, type } → { type, value, count }
 *                                                          (count | sum | avg | min | max of values in a collection)
 *   - search        { query, collection? } → { results: [...] }
 *   - touch         { key, value, collection? } → full record (upsert + return)
 */

type RpcName = 'count_records' | 'sum' | 'aggregate' | 'search' | 'touch'
const KNOWN: RpcName[] = ['count_records', 'sum', 'aggregate', 'search', 'touch']

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  if (!KNOWN.includes(name as RpcName)) {
    return fail(
      `Unknown RPC function "${name}". Available: ${KNOWN.join(', ')}.`,
      404,
    )
  }

  const body = await req.json().catch(() => ({}))

  try {
    switch (name as RpcName) {
      case 'count_records':
        return ok(handleCountRecords(user))
      case 'sum':
        return ok(handleSum(user, body))
      case 'aggregate':
        return ok(handleAggregate(user, body))
      case 'search':
        return ok(handleSearch(user, body))
      case 'touch':
        return await handleTouch(user, body)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return fail(`RPC "${name}" failed: ${message}`, 500)
  }
}

// ─── Handlers ────────────────────────────────────────────────────────────────

function handleCountRecords(user: AuthenticatedUser) {
  return { count: countRecords(user.dbUserId) }
}

function handleSum(
  user: AuthenticatedUser,
  body: { key?: string; collection?: string },
) {
  if (typeof body.key !== 'string' || !body.key.trim()) {
    throw new Error('`key` (string) is required for sum().')
  }
  const targetKey = body.key.trim()
  const collection =
    typeof body.collection === 'string' && body.collection.trim()
      ? body.collection.trim()
      : undefined

  const rows = listRecords(user.dbUserId, collection)
  let sum = 0
  let count = 0
  for (const r of rows) {
    if (r.key !== targetKey) continue
    const parsed = safeParse(r.value)
    if (typeof parsed === 'number' && Number.isFinite(parsed)) {
      sum += parsed
      count++
    }
  }
  return { key: targetKey, sum, count }
}

function handleAggregate(
  user: AuthenticatedUser,
  body: { collection?: string; type?: string },
) {
  if (typeof body.collection !== 'string' || !body.collection.trim()) {
    throw new Error('`collection` (string) is required for aggregate().')
  }
  const type =
    typeof body.type === 'string' && body.type.trim()
      ? body.type.trim().toLowerCase()
      : 'count'
  if (!['count', 'sum', 'avg', 'min', 'max'].includes(type)) {
    throw new Error(`Unknown aggregate type "${type}". Use count|sum|avg|min|max.`)
  }
  const rows = listRecords(user.dbUserId, body.collection.trim())
  const nums: number[] = []
  for (const r of rows) {
    const parsed = safeParse(r.value)
    if (typeof parsed === 'number' && Number.isFinite(parsed)) nums.push(parsed)
  }

  let value: number
  switch (type) {
    case 'count':
      value = rows.length
      break
    case 'sum':
      value = nums.reduce((a, b) => a + b, 0)
      break
    case 'avg':
      value = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
      break
    case 'min':
      value = nums.length > 0 ? Math.min(...nums) : 0
      break
    case 'max':
      value = nums.length > 0 ? Math.max(...nums) : 0
      break
    default:
      value = 0
  }
  return {
    collection: body.collection.trim(),
    type,
    value,
    count: rows.length,
    numericCount: nums.length,
  }
}

function handleSearch(
  user: AuthenticatedUser,
  body: { query?: string; collection?: string; limit?: number },
) {
  if (typeof body.query !== 'string' || !body.query.trim()) {
    throw new Error('`query` (string) is required for search().')
  }
  const needle = body.query.trim().toLowerCase()
  const collection =
    typeof body.collection === 'string' && body.collection.trim()
      ? body.collection.trim()
      : undefined
  const limit =
    typeof body.limit === 'number' && body.limit > 0
      ? Math.min(body.limit, 1000)
      : 100

  const rows = listRecords(user.dbUserId, collection)
  const results: Array<{
    key: string
    value: unknown
    valueType: string
    collection: string
    matchedOn: 'key' | 'value' | 'both'
    updatedAt: string
  }> = []

  for (const r of rows) {
    if (results.length >= limit) break
    const keyHit = r.key.toLowerCase().includes(needle)
    const valueStr = r.value.toLowerCase()
    const valueHit = valueStr.includes(needle)
    if (!keyHit && !valueHit) continue
    let parsed: unknown = r.value
    try {
      parsed = JSON.parse(r.value)
    } catch {
      /* keep raw */
    }
    results.push({
      key: r.key,
      value: parsed,
      valueType: r.valueType,
      collection: r.collection,
      matchedOn: keyHit && valueHit ? 'both' : keyHit ? 'key' : 'value',
      updatedAt: r.updatedAt,
    })
  }
  return { query: body.query.trim(), count: results.length, results }
}

async function handleTouch(
  user: AuthenticatedUser,
  body: { key?: string; value?: unknown; collection?: string },
) {
  if (typeof body.key !== 'string' || !body.key.trim()) {
    return fail('`key` (string) is required for touch().', 400)
  }
  if (body.value === undefined) {
    return fail('`value` is required for touch().', 400)
  }
  const collection =
    typeof body.collection === 'string' && body.collection.trim()
      ? body.collection.trim()
      : 'default'

  // If value came as a string, coerce; else store as-is.
  const isRawString = typeof body.value === 'string'
  const json = isRawString
    ? coerceValue(body.value as string).value
    : body.value

  const record = await setKey(user, {
    key: body.key.trim(),
    collection,
    source: 'api',
    json,
  })
  return ok({ record, action: 'upserted' })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// Suppress unused import warning — listCollections may be useful in future RPCs.
void listCollections

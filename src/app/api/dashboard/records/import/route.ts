import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { importRecords } from '@/lib/kv'

export const runtime = 'nodejs'

const MAX_RECORDS = 5000

/**
 * POST /api/dashboard/records/import
 * Body: { "records": [{ "key", "value", "collection"? }] }
 * Bulk-upserts records with a SINGLE manifest sync (one pin) for the whole
 * batch — per-key syncs would throttle Telegram's same-chat pin limit.
 * Idempotent: safe to retry the batch when durable=false.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => null)
  if (!body || !Array.isArray(body.records)) {
    return fail('`records` (array) is required.', 400)
  }
  if (body.records.length === 0) return fail('`records` is empty.', 400)
  if (body.records.length > MAX_RECORDS) {
    return fail(`Too many records (max ${MAX_RECORDS} per batch).`, 400)
  }
  for (const r of body.records) {
    if (!r || typeof r.key !== 'string' || !r.key.trim()) {
      return fail('Every record needs a non-empty string `key`.', 400)
    }
    if (r.value === undefined) {
      return fail(`Record "${r.key}" is missing \`value\`.`, 400)
    }
  }

  const result = await importRecords(
    user,
    body.records.map((r: { key: string; collection?: string; value: unknown }) => ({
      key: r.key.trim(),
      collection: typeof r.collection === 'string' && r.collection ? r.collection : 'default',
      json: r.value,
    })),
    'dashboard',
  )
  return ok(result)
}

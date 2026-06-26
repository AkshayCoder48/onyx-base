import { NextRequest } from 'next/server'
import { authenticate, fail, ok } from '@/lib/auth'
import { listKeys } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * GET /v1/list?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Returns just the keys (compact, CLI-friendly). Use /v1/export for full values.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const collection = req.nextUrl.searchParams.get('collection') || undefined
  const records = await listKeys(user, collection)
  return ok({ keys: records.map((r) => r.key), count: records.length })
}

import { NextRequest } from 'next/server'
import { authenticate, fail, ok } from '@/lib/auth'
import { deleteKey } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * DELETE /v1/delete/[key]?collection=default
 * Auth: Authorization: Bearer kv_live_xxx
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { key } = await params
  const collection = req.nextUrl.searchParams.get('collection') || 'default'
  const removed = await deleteKey(user, key, collection, 'api')
  if (!removed) {
    return fail(`Key "${key}" not found in collection "${collection}".`, 404)
  }
  return ok({ deleted: true, key, collection })
}

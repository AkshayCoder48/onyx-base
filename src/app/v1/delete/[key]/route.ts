import { NextRequest } from 'next/server'
import { authenticateOrRespond, authorize, authorizeFailResponse, fail, ok } from '@/lib/auth'
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
  const auth = await authenticateOrRespond(req.headers.get('authorization'))
  if ('errorResponse' in auth) return auth.errorResponse
  const user = auth.user

  const { key } = await params
  const collection = req.nextUrl.searchParams.get('collection') || 'default'

  const z = authorize(user, req, { scope: 'delete', collection })
  if (!z.ok) return authorizeFailResponse(z)

  const removed = await deleteKey(user, key, collection, 'api')
  if (!removed) {
    return fail(`Key "${key}" not found in collection "${collection}".`, 404)
  }
  return ok({ deleted: true, key, collection })
}

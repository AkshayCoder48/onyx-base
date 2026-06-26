import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { deleteKey } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * DELETE /api/dashboard/records/[key]?collection=default
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { key } = await params
  const collection = req.nextUrl.searchParams.get('collection') || 'default'
  const removed = await deleteKey(user, key, collection, 'dashboard')
  if (!removed) return fail('Record not found.', 404)
  return ok({ deleted: true })
}

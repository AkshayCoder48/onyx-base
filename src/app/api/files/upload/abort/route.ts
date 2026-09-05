import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getSession, deleteSession } from '@/lib/chunked-upload'

export const runtime = 'nodejs'

/**
 * POST /api/files/upload/abort — discard an in-progress upload session.
 *
 * Body (JSON): { uploadId }. Frees the session's temp directory immediately
 * (don't wait for the 2h TTL janitor).
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let uploadId = ''
  try {
    const body = (await req.json()) as { uploadId?: unknown }
    if (typeof body.uploadId === 'string') uploadId = body.uploadId
  } catch {
    /* fall through */
  }
  if (!uploadId) return fail('Expected a JSON body: { uploadId }.', 400)

  const session = await getSession(uploadId)
  if (!session || session.userId !== user.dbUserId) {
    // Aborting an unknown/expired session is a no-op success — idempotent.
    return ok({ aborted: true, existed: false })
  }

  await deleteSession(uploadId)
  return ok({ aborted: true, existed: true })
}

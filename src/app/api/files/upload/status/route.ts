import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getSession, receivedChunkIndexes, SESSION_TTL_MS } from '@/lib/chunked-upload'

export const runtime = 'nodejs'

/**
 * GET /api/files/upload/status?uploadId=<id> — resume support.
 *
 * Response: { session: { fileName, size, chunkSize, chunkCount }, receivedChunks,
 *            missingChunks, expiresAtMs }.
 *
 * A resuming client uploads only `missingChunks`, in any order.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const uploadId = req.nextUrl.searchParams.get('uploadId') ?? ''
  const session = await getSession(uploadId)
  if (!session || session.userId !== user.dbUserId) {
    return fail('Session not found.', 404)
  }

  const received = await receivedChunkIndexes(uploadId)
  const missing: number[] = []
  for (let i = 0; i < session.chunkCount; i++) {
    if (!received.includes(i)) missing.push(i)
  }

  return ok({
    session: {
      fileName: session.fileName,
      size: session.size,
      chunkSize: session.chunkSize,
      chunkCount: session.chunkCount,
    },
    receivedChunks: received,
    missingChunks: missing,
    complete: missing.length === 0,
    expiresAtMs: session.createdAt + SESSION_TTL_MS,
  })
}

import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { createSession, sweepStaleSessions, DEFAULT_CHUNK_SIZE } from '@/lib/chunked-upload'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'
export const maxDuration = 60

/**
 * POST /api/files/upload/init — begin a chunked upload session.
 *
 * Body (JSON): { fileName, mimeType, size, label?, isPublic?, chunkSize? }
 * Response:    { uploadId, chunkSize, chunkCount, receivedChunks: [] }
 *
 * Auth: Bearer API key (same as every dashboard route).
 *
 * The janitor runs opportunistically here (rate-limited to once / 5 min) so
 * abandoned sessions can never fill /tmp even if the cron script isn't set up.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let body: {
    fileName?: unknown
    mimeType?: unknown
    size?: unknown
    label?: unknown
    isPublic?: unknown
    chunkSize?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return fail('Expected a JSON body: { fileName, mimeType, size, label?, isPublic?, chunkSize? }.', 400)
  }

  const fileName = typeof body.fileName === 'string' ? body.fileName : ''
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream'
  const size = typeof body.size === 'number' ? body.size : NaN
  const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : null
  const isPublic = typeof body.isPublic === 'boolean' ? body.isPublic : true
  const chunkSize =
    typeof body.chunkSize === 'number' && Number.isFinite(body.chunkSize)
      ? Math.floor(body.chunkSize)
      : DEFAULT_CHUNK_SIZE

  if (!fileName.trim()) return fail('`fileName` is required.', 400)

  // Opportunistic janitor — never blocks the upload on failure.
  void sweepStaleSessions().catch(() => {})

  let session
  try {
    session = await createSession(user.dbUserId, {
      fileName: fileName.trim(),
      mimeType,
      size,
      label,
      isPublic,
      chunkSize,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not start the upload session.', 400)
  }

  await logAction(user, 'file.upload.init', undefined, `${session.fileName} (${session.size} bytes, ${session.chunkCount} chunks)`, 'dashboard').catch(() => {})

  return ok({
    uploadId: session.uploadId,
    chunkSize: session.chunkSize,
    chunkCount: session.chunkCount,
    receivedChunks: [],
    resumeUrl: `/api/files/upload/status?uploadId=${session.uploadId}`,
  })
}

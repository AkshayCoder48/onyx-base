import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getSession, writeChunk, receivedChunkIndexes, deleteSession } from '@/lib/chunked-upload'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/files/upload/chunk?uploadId=<id>&index=<n> — append one chunk.
 *
 * The request body is the RAW chunk bytes (application/octet-stream), sized
 * exactly to the negotiated chunkSize (last chunk may be shorter). Streaming
 * straight to disk keeps memory O(chunkSize) per request.
 *
 * Auth: Bearer API key; the session must belong to the same user.
 * Idempotent: a retried chunk index simply overwrites its own part-file.
 *
 * 404 SESSION_NOT_FOUND means the session expired (TTL 2h) or, on
 * multi-instance deployments, the request hit an instance that never saw the
 * init — the client should re-init and restart the transfer.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const uploadId = req.nextUrl.searchParams.get('uploadId') ?? ''
  const indexRaw = req.nextUrl.searchParams.get('index') ?? ''
  const index = Number.parseInt(indexRaw, 10)

  const session = await getSession(uploadId)
  if (!session) {
    return fail('SESSION_NOT_FOUND — the upload session expired or was created on another instance. Re-init and retry.', 404)
  }
  if (session.userId !== user.dbUserId) {
    // Don't confirm existence to strangers.
    return fail('SESSION_NOT_FOUND — the upload session expired or was created on another instance. Re-init and retry.', 404)
  }
  if (!Number.isInteger(index)) {
    return fail('`index` query parameter (integer chunk number) is required.', 400)
  }

  // Content-Length is trustworthy here ONLY as a size hint — we validate the
  // exact expected byte count inside writeChunk.
  const declaredSize = Number.parseInt(req.headers.get('content-length') ?? '', 10)

  let result: { ok: true } | { ok: false; error: string }
  if (req.body) {
    result = await writeChunk(uploadId, index, req.body, Number.isFinite(declaredSize) ? declaredSize : Number.NaN)
  } else {
    return fail('Empty chunk body.', 400)
  }

  if (!result.ok) {
    if (result.error === 'SESSION_NOT_FOUND') {
      return fail('SESSION_NOT_FOUND — the upload session expired or was created on another instance. Re-init and retry.', 404)
    }
    return fail(result.error, 400)
  }

  const received = await receivedChunkIndexes(uploadId)
  return ok({
    received: received.length,
    total: session.chunkCount,
    // Small completeness hint so simple clients can stop polling status.
    complete: received.length === session.chunkCount,
  })
}

/** DELETE /api/files/upload/chunk?uploadId= — convenience alias for abort. */
export async function DELETE(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)
  const uploadId = req.nextUrl.searchParams.get('uploadId') ?? ''
  const session = await getSession(uploadId)
  if (!session || session.userId !== user.dbUserId) {
    return fail('Session not found.', 404)
  }
  await deleteSession(uploadId)
  return ok({ aborted: true })
}

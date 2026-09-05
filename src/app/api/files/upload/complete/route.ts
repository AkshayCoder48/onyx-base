import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import {
  getSession,
  isComplete,
  assembleBlob,
  receivedChunkIndexes,
  deleteSession,
} from '@/lib/chunked-upload'
import { uploadFile, fileView } from '@/lib/data-store'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'
// Assembly + Telegram transfer of a big file can legitimately take minutes.
export const maxDuration = 300

/**
 * POST /api/files/upload/complete — assemble, ship to Telegram, register.
 *
 * Body (JSON): { uploadId }
 * Response:    { file: FileView, maxFileSize, maxFileUploadBytes } — the same
 *              shape as the single-shot POST /api/files so the UI can treat
 *              both paths identically.
 *
 * The assembled Blob is verified against the declared size BEFORE the Telegram
 * transfer; on mismatch the session is discarded (no partial uploads land in
 * storage) and the client gets a clear error.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let uploadId = ''
  try {
    const body = (await req.json()) as { uploadId?: unknown }
    if (typeof body.uploadId === 'string') uploadId = body.uploadId
  } catch {
    /* fall through — uploadId stays '' */
  }
  if (!uploadId) return fail('Expected a JSON body: { uploadId }.', 400)

  const session = await getSession(uploadId)
  if (!session || session.userId !== user.dbUserId) {
    return fail('Session not found (it may have expired — TTL is 2 hours). Re-init and re-upload.', 404)
  }

  if (!(await isComplete(uploadId))) {
    const received = await receivedChunkIndexes(uploadId)
    const missing: number[] = []
    for (let i = 0; i < session.chunkCount; i++) {
      if (!received.includes(i)) missing.push(i)
    }
    return fail(
      `Upload is incomplete — ${received.length}/${session.chunkCount} chunks received. Missing: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`,
      409,
    )
  }

  let blob: Blob
  try {
    blob = await assembleBlob(uploadId)
  } catch (err) {
    // Corrupt / mismatched assembly — discard so the user can retry cleanly.
    await deleteSession(uploadId).catch(() => {})
    return fail(
      err instanceof Error ? err.message : 'Assembly failed — the session was discarded. Please retry the upload.',
      400,
    )
  }

  // Reuse the exact same registration path as the single-shot uploader:
  // storage routing (custom vs server Telegram), size ceilings, file record
  // creation, Telegram mirroring — all identical.
  const result = await uploadFile(user.dbUserId, {
    file: blob,
    fileName: session.fileName,
    mimeType: session.mimeType,
    size: session.size,
    label: session.label,
    isPublic: session.isPublic,
  })

  // The temp session has served its purpose — always clean up.
  await deleteSession(uploadId).catch(() => {})

  if ('error' in result) {
    return fail(result.error, 413)
  }

  await logAction(
    user,
    'file.upload',
    undefined,
    `${session.fileName} (${session.size} bytes, chunked ×${session.chunkCount})`,
    'dashboard',
  ).catch(() => {})

  return ok({ file: fileView(result.record, getPublicOrigin(req)) })
}

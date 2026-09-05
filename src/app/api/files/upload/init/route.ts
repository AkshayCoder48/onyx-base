import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { planUpload, sweepStaleSessions } from '@/lib/chunked-upload'
import { resolveStorageMode, resolveBotApiBaseUrl } from '@/lib/data-store'
import { effectiveUploadLimitBytes } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * POST /api/files/upload/init — mint an upload plan (STATELESS).
 *
 * Body:     { fileName, mimeType, size, label?, isPublic?, chunkSize? }
 * Response: { uploadId, chunkSize, chunkCount, size, fileName, mimeType,
 *             label, isPublic, maxUploadBytes }
 *
 * The server keeps NO session state. The client echoes the plan fields on
 * every chunk / status / complete / abort call and each route re-validates
 * them — that is what makes the protocol safe on multi-instance serverless
 * platforms (any instance can serve any step).
 *
 * Size is validated against the STORAGE BACKEND ceiling here (cloud Bot API
 * 50 MB / local Bot API 2 GB) so oversized transfers fail fast with a clear
 * message instead of dying at the final assembly step.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let meta: {
    fileName?: unknown
    mimeType?: unknown
    size?: unknown
    label?: unknown
    isPublic?: unknown
    chunkSize?: unknown
  }
  try {
    meta = (await req.json()) as typeof meta
  } catch {
    return fail('Expected a JSON body: { fileName, mimeType, size, label?, isPublic?, chunkSize? }.', 400)
  }
  if (typeof meta.fileName !== 'string' || !meta.fileName.trim()) {
    return fail('`fileName` (string) is required.', 400)
  }
  if (typeof meta.size !== 'number') {
    return fail('`size` (number, bytes) is required.', 400)
  }

  let plan
  try {
    plan = planUpload({
      fileName: meta.fileName,
      mimeType: typeof meta.mimeType === 'string' ? meta.mimeType : 'application/octet-stream',
      size: meta.size,
      label: typeof meta.label === 'string' ? meta.label : null,
      isPublic: meta.isPublic !== false,
      chunkSize: typeof meta.chunkSize === 'number' ? meta.chunkSize : undefined,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Invalid upload plan.', 400)
  }

  // Fail fast when the declared size exceeds the storage backend's ceiling.
  const storageMode = resolveStorageMode(user.dbUserId)
  const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)
  const maxUploadBytes = effectiveUploadLimitBytes(botApiBaseUrl)
  if (plan.size > maxUploadBytes) {
    const hint = botApiBaseUrl
      ? 'The file exceeds the 2 GB local Bot API server limit.'
      : 'The file exceeds the 50 MB cloud Bot API upload limit. To upload files up to 2 GB, configure a custom local Bot API server URL in Settings → Telegram chat ID.'
    return fail(`File is ${(plan.size / 1024 / 1024).toFixed(1)} MB — ${hint}`, 413)
  }

  // Opportunistic janitor — clears crashed assembly workspaces from /tmp.
  await sweepStaleSessions().catch(() => {})

  return ok({
    uploadId: plan.uploadId,
    chunkSize: plan.chunkSize,
    chunkCount: plan.chunkCount,
    size: plan.size,
    fileName: plan.fileName,
    mimeType: plan.mimeType,
    label: plan.label,
    isPublic: plan.isPublic,
    storageMode,
    maxUploadBytes,
  })
}

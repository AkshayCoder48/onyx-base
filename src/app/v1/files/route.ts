import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import {
  listFileRecords,
  uploadFile,
  fileView,
  MAX_FILE_SIZE,
  resolveBotApiBaseUrl,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { effectiveUploadLimitBytes } from '@/lib/telegram'

export const runtime = 'nodejs'
export const maxDuration = 300

/**
 * GET /v1/files
 * Auth: Authorization: Bearer kv_live_xxx
 *
 * Lists all stored files. Returns the permanent `/f/<fileId>` download URL for
 * each — that link works without auth (unless the file was marked private).
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const files = listFileRecords(user.dbUserId).map((f) => fileView(f, getPublicOrigin(req)))
  const maxFileUploadBytes = effectiveUploadLimitBytes(resolveBotApiBaseUrl(user.dbUserId))
  return ok({ files, maxFileSize: MAX_FILE_SIZE, maxFileUploadBytes })
}

/**
 * POST /v1/files
 * Auth: Authorization: Bearer kv_live_xxx
 * Body: multipart/form-data with a `file` field (any extension, up to 2 GB).
 *
 * Optional form fields: `label`, `public` ("true"|"false").
 *
 * Uploads the file to the user's Telegram chat and returns a permanent
 * download URL. Designed for terminal/CLI/code use — `curl`, `onyx upload`,
 * or any HTTP client.
 *
 *   curl -X POST https://your-server/v1/files \
 *     -H "Authorization: Bearer kv_live_xxx" \
 *     -F "file=@./report.pdf" \
 *     -F "label=Q3 report"
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return fail('Expected multipart/form-data with a `file` field.', 400)
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return fail('No `file` field found in the upload.', 400)
  }

  const label = (form.get('label') as string | null)?.trim() || null
  const publicFlag = form.get('public')
  const isPublic = publicFlag === null ? true : publicFlag !== 'false'

  const fileName = file.name || 'untitled'
  const mimeType = file.type || 'application/octet-stream'

  const result = await uploadFile(user.dbUserId, {
    file: file as unknown as Blob,
    fileName,
    mimeType,
    size: file.size,
    label,
    isPublic,
  })

  if ('error' in result) {
    return fail(result.error, 413)
  }

  await logAction(user, 'file.upload', undefined, `${fileName} (${file.size} bytes)`, 'api')

  return ok({
    file: fileView(result.record, getPublicOrigin(req)),
    maxFileSize: MAX_FILE_SIZE,
    maxFileUploadBytes: effectiveUploadLimitBytes(resolveBotApiBaseUrl(user.dbUserId)),
  })
}

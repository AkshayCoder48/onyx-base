import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import {
  listFileRecords,
  uploadFile,
  fileView,
  MAX_FILE_SIZE,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'

export const runtime = 'nodejs'
// Allow large multipart uploads (up to 2 GB). Next.js route handlers stream
// the request body, so this just disables any default body-size guard.
export const maxDuration = 300

/** GET /api/files — list the developer's stored files. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const origin = getPublicOrigin(req)
  const files = listFileRecords(user.dbUserId).map((f) => fileView(f, origin))
  return ok({ files, maxFileSize: MAX_FILE_SIZE })
}

/**
 * POST /api/files — upload a file (multipart/form-data with a `file` field).
 *
 * Accepts ANY file extension (exe, txt, png, jpg, zip, …). The file is streamed
 * to the user's Telegram chat via `sendDocument`, then indexed locally with the
 * returned Telegram file_id. A permanent `/f/<fileId>` link is returned that
 * proxies downloads through this server (the Telegram URL is never exposed).
 *
 * Optional form fields:
 *   - label   : human-friendly note
 *   - public  : "true"|"false" — whether the link works without auth (default true)
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

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

  await logAction(user, 'file.upload', undefined, `${fileName} (${file.size} bytes)`, 'dashboard')

  return ok({
    file: fileView(result.record, getPublicOrigin(req)),
    maxFileSize: MAX_FILE_SIZE,
  })
}

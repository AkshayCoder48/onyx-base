import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail, getPublicOrigin } from '@/lib/auth'
import {
  findFileById,
  deleteFileRecord,
  fileView,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'

/** GET /v1/files/[id] — fetch one file's metadata (owner only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(user, req, { scope: 'files' })
  if (!z.ok) return authorizeFailResponse(z)

  const { id } = await params
  const file = findFileById(user.dbUserId, id)
  if (!file) return fail('File not found.', 404)

  return ok({ file: fileView(file, getPublicOrigin(req)) })
}

/** DELETE /v1/files/[id] — permanently delete a file (DB + Telegram message). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(user, req, { scope: 'files' })
  if (!z.ok) return authorizeFailResponse(z)

  const { id } = await params
  const removed = deleteFileRecord(user.dbUserId, id)
  if (!removed) return fail('File not found.', 404)

  await logAction(user, 'file.delete', undefined, removed.fileName, 'api')
  return ok({ deleted: true, id })
}

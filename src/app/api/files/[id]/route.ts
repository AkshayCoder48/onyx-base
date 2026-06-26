import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import {
  findFileById,
  deleteFileRecord,
  fileView,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'

/** GET /api/files/[id] — fetch one file's metadata (owner only). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const file = findFileById(user.dbUserId, id)
  if (!file) return fail('File not found.', 404)

  return ok({ file: fileView(file, getPublicOrigin(req)) })
}

/** DELETE /api/files/[id] — permanently delete a file (DB + Telegram message). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { id } = await params
  const removed = deleteFileRecord(user.dbUserId, id)
  if (!removed) return fail('File not found.', 404)

  await logAction(user, 'file.delete', undefined, removed.fileName, 'dashboard')
  return ok({ deleted: true, id })
}

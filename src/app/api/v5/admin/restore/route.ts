/**
 * POST /api/v5/admin/restore — rebuild the SQLite store from the latest
 * Telegram snapshot (disaster recovery). Optional body { fileId } restores a
 * specific snapshot document (manual recovery from chat history).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { restoreV5FromTelegram } from '@/lib/v5/backup'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const POST = withV5Handler({
  operation: 'admin.restore',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    if (ctx.user!.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Restore requires an admin/master key.', 403)
    }
    const body = (await req.json().catch(() => ({}))) as { fileId?: string }
    const result = await restoreV5FromTelegram(body.fileId ? { fileId: body.fileId } : undefined)
    if (!result.ok) {
      throw new V5Error('STORAGE_UNAVAILABLE', result.reason ?? 'Restore failed.', 502)
    }
    return ctx.ok(result)
  },
})

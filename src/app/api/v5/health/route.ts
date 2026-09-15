/**
 * GET /api/v5/health — engine + backup status (docs/v5-contract.md §19).
 */
import { withV5Handler } from '@/lib/v5/handler'
import { v5Configured, v5Ping, isFileMode } from '@/lib/v5/db'
import { blobBackendLabel } from '@/lib/v5/blobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withV5Handler({
  operation: 'health',
  auth: 'none',
  handler: async (_req, ctx) => {
    if (!v5Configured()) {
      return ctx.ok({ status: 'disabled', db: { ok: false, latencyMs: 0 }, blobBackend: 'n/a', telegramBackup: false })
    }
    const ping = await v5Ping()
    return ctx.ok({
      status: ping.ok ? 'healthy' : 'unhealthy',
      db: { ok: ping.ok, latencyMs: ping.latencyMs },
      mode: isFileMode() ? 'file' : 'libsql-remote',
      blobBackend: blobBackendLabel(),
      telegramBackup: process.env.V5_TELEGRAM_BACKUP !== 'false',
    })
  },
})

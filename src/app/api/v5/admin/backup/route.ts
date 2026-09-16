/**
 * /api/v5/admin/backup — Telegram snapshot backup control ("data saver").
 *   GET  → snapshot status (local counters + pinned-index registration).
 *   POST → upload a full-state snapshot NOW (admin/master keys only).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { snapshotStatus, uploadV5Snapshot, getBioPointer, V5_SNAPSHOT_ACCOUNT } from '@/lib/v5/backup'
import { fetchAccountIndex, isTelegramConfigured } from '@/lib/telegram'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

export const GET = withV5Handler({
  operation: 'admin.backup',
  auth: 'bearer',
  handler: async (_req: NextRequest, ctx) => {
    if (ctx.user!.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Backup control requires an admin/master key.', 403)
    }
    const registered = isTelegramConfigured()
      ? ((await fetchAccountIndex())?.accounts as Record<string, unknown> | undefined)?.[V5_SNAPSHOT_ACCOUNT] ?? null
      : null
    // Live shared-pointer state (bio first, pinned index fallback) — the
    // ground truth for cross-instance convergence debugging.
    const bio = isTelegramConfigured() ? await getBioPointer().catch(() => null) : null
    return ctx.ok({ ...snapshotStatus(), telegram: { configured: isTelegramConfigured() }, registeredSnapshot: registered, bioPointer: bio })
  },
})

export const POST = withV5Handler({
  operation: 'admin.backup',
  auth: 'bearer',
  handler: async (_req: NextRequest, ctx) => {
    if (ctx.user!.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Backup control requires an admin/master key.', 403)
    }
    const result = await uploadV5Snapshot('manual')
    if (!result.ok) {
      throw new V5Error('STORAGE_UNAVAILABLE', result.reason ?? 'Snapshot upload failed.', 502)
    }
    return ctx.ok(result)
  },
})

import { withApiHandler } from '@/lib/with-api-handler'
import { snapshot } from '@/lib/storage-queue'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/diagnostics/queue
 *
 * Returns a snapshot of the current user's durable write operations. Used by
 * the Diagnostics view to show pending / failed / retrying operations.
 *
 * The payload contents are NEVER included (they may contain user data). Only
 * metadata is returned.
 */
export const GET = withApiHandler({
  operation: 'diagnostics.queue.read',
  requireAuth: true,
  handler: async (req, ctx) => {
    const user = ctx.user!
    const snap = snapshot({ dbUserId: user.dbUserId })
    ctx.log({ stage: 'diagnostics.queue', counts: { pending: snap.pending, failed: snap.failed, retrying: snap.retrying } })
    return ctx.ok({ ...snap })
  },
})

import { withApiHandler } from '@/lib/with-api-handler'
import { retryAllFailed } from '@/lib/storage-queue'

export const runtime = 'nodejs'

/**
 * POST /api/dashboard/diagnostics/queue/retry
 *
 * Force-retry every failed operation in the durable write queue. Returns the
 * count of operations that were re-queued.
 */
export const POST = withApiHandler({
  operation: 'diagnostics.queue.retry',
  requireAuth: true,
  handler: async (req, ctx) => {
    // NOTE: retryAllFailed is global (it retries ALL failed ops in the queue,
    // not just the current user's). For now this is acceptable — admin
    // operations are the only ones that would have failed ops from other
    // users, and admins are trusted. In a multi-tenant production setup we'd
    // filter by dbUserId.
    const retried = retryAllFailed()
    ctx.log({ stage: 'diagnostics.queue.retry', retried })
    return ctx.ok({ retried })
  },
})

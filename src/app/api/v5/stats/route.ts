/**
 * GET /api/v5/stats — maintained counters (docs/v5-contract.md §21).
 */
import { withV5Handler } from '@/lib/v5/handler'
import { kvStats, kvCollections } from '@/lib/v5/kv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withV5Handler({
  operation: 'stats',
  auth: 'bearer',
  handler: async (_req, ctx) => {
    const [counters, collections] = await Promise.all([kvStats(ctx.user!.owner), kvCollections(ctx.user!.owner)])
    return ctx.ok({ counters, collections })
  },
})

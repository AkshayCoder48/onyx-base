/**
 * GET /api/v5/export — paginated full-value export (docs/v5-contract.md §6).
 */
import { NextRequest } from 'next/server'
import { withV5Handler } from '@/lib/v5/handler'
import { kvPage } from '@/lib/v5/kv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withV5Handler({
  operation: 'kv.export',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    const sp = req.nextUrl.searchParams
    const page = await kvPage(ctx.user!.owner, {
      collection: sp.get('collection') || 'default',
      limit: Number(sp.get('limit')) || 1000,
      offset: Number(sp.get('offset')) || 0,
    })
    // V4-compatible shape: { data: { key: value, …, __pagination } }
    const data: Record<string, unknown> = {}
    for (const item of page.items) data[item.key] = item.value
    data.__pagination = { total: page.total, limit: page.limit, offset: page.offset, hasMore: page.hasMore }
    return ctx.ok({ data })
  },
})

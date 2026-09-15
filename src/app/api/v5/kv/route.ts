/**
 * GET /api/v5/kv — paginated, indexed collection scan (docs/v5-contract.md §5).
 */
import { NextRequest } from 'next/server'
import { withV5Handler } from '@/lib/v5/handler'
import { kvPage } from '@/lib/v5/kv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withV5Handler({
  operation: 'kv.list',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    const sp = req.nextUrl.searchParams
    const page = await kvPage(ctx.user!.owner, {
      collection: sp.get('collection') || 'default',
      prefix: sp.get('prefix') || undefined,
      limit: Number(sp.get('limit')) || 100,
      offset: Number(sp.get('offset')) || 0,
    })
    return ctx.ok(page)
  },
})

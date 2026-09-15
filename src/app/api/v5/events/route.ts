/**
 * GET /api/v5/events — poll event log (docs/v5-contract.md §17).
 */
import { NextRequest } from 'next/server'
import { withV5Handler } from '@/lib/v5/handler'
import { queryEvents } from '@/lib/v5/events'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withV5Handler({
  operation: 'events.poll',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    const sp = req.nextUrl.searchParams
    const types = (sp.get('types') || '').split(',').map((t) => t.trim()).filter(Boolean)
    const result = await queryEvents(ctx.user!.owner, {
      since: Number(sp.get('since')) || 0,
      types,
      limit: Number(sp.get('limit')) || 100,
    })
    return ctx.ok(result)
  },
})

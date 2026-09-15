/**
 * PUT /api/v5/blobs/:id/data — streamed byte ingestion (docs/v5-contract.md §12).
 * The body is piped chunk-by-chunk into staging; the full body is NEVER
 * buffered in RAM.
 */
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { ingestData } from '@/lib/v5/blobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Ctx = { params: Promise<{ id: string }> }

export const PUT = withV5Handler({
  operation: 'blobs.data',
  auth: 'bearer',
  handler: async (req, ctx, routeCtx?: Ctx) => {
    const { id } = await routeCtx!.params
    const result = await ingestData(id, ctx.user!.owner, req.body)
    return ctx.ok(result)
  },
})

export const POST = PUT

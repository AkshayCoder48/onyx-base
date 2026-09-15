/**
 * GET /api/v5/operations/:id — authoritative operation status (§9).
 */
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { getOp } from '@/lib/v5/ops'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = withV5Handler({
  operation: 'operations.get',
  auth: 'bearer',
  handler: async (_req, ctx, routeCtx?: Ctx) => {
    const { id } = await routeCtx!.params
    const op = await getOp(id)
    if (!op || op.owner !== ctx.user!.owner) {
      throw new V5Error('NOT_FOUND', 'Operation not found.', 404)
    }
    return ctx.ok({
      id: op.id,
      status: op.status,
      type: op.type,
      result: op.result ?? undefined,
      error: op.errorCode ? { code: op.errorCode, message: op.errorMessage } : undefined,
      createdAt: op.createdAt,
      updatedAt: op.updatedAt,
      durationMs: op.durationMs,
    })
  },
})

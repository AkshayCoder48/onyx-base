/**
 * POST /api/v5/operations/lookup — find an operation by (type, idemKey)
 * for the authenticated owner (docs/v5-contract.md §10). This is the
 * lost-response recovery primitive.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { lookupOp } from '@/lib/v5/ops'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withV5Handler({
  operation: 'operations.lookup',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    const body = (await req.json().catch(() => null)) as { type?: string; idemKey?: string } | null
    const type = typeof body?.type === 'string' ? body.type : ''
    const idemKey = typeof body?.idemKey === 'string' ? body.idemKey : ''
    if (!/^[a-z0-9._:-]{2,64}$/.test(type) || !/^[A-Za-z0-9._:-]{4,128}$/.test(idemKey)) {
      throw new V5Error('VALIDATION_ERROR', 'Body must include valid "type" and "idemKey".', 400)
    }
    const op = await lookupOp(ctx.user!.owner, type, idemKey)
    if (!op) throw new V5Error('NOT_FOUND', 'No operation for that idempotency key.', 404)
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

/**
 * /api/v5/kv/:key — GET / PUT|POST / DELETE (docs/v5-contract.md §1-3).
 *
 * PUT supports Idempotency-Key replay semantics via the durable ops table.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { kvGet, kvSet, kvDelete } from '@/lib/v5/kv'
import { beginOp, completeOp, OpConflictError } from '@/lib/v5/ops'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

type Ctx = { params: Promise<{ key: string }> }

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

export const GET = withV5Handler({
  operation: 'kv.get',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const key = decodeKey((await routeCtx!.params).key)
    const collection = req.nextUrl.searchParams.get('collection') || 'default'
    const row = await kvGet(ctx.user!.owner, key, collection)
    if (!row) throw new V5Error('NOT_FOUND', `Key "${key}" not found in collection "${collection}".`, 404)
    return ctx.ok({ key: row.key, collection: row.collection, value: row.value, updatedAt: row.updatedAt })
  },
})

export const PUT = withV5Handler({
  operation: 'kv.set',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const key = decodeKey((await routeCtx!.params).key)
    const body = (await req.json().catch(() => null)) as { value?: unknown; collection?: string } | null
    if (!body || body.value === undefined) {
      throw new V5Error('VALIDATION_ERROR', 'Body must be JSON with a "value" field.', 400)
    }
    const collection = (body.collection || 'default').slice(0, 128)
    const idemKey = req.headers.get('idempotency-key') || req.headers.get('x-idempotency-key') || undefined

    let opId: string | undefined
    if (idemKey && /^[A-Za-z0-9._:-]{4,128}$/.test(idemKey)) {
      try {
        const begun = await beginOp(ctx.user!.owner, 'kv.set', { key, collection }, idemKey)
        if (begun.existed) {
          // Durable replay — return the recorded outcome.
          const result = begun.op.result as { key: string; collection: string; value: unknown; updatedAt: number } | null
          if (begun.op.status === 'completed' && result) {
            return ctx.ok({ ...result, committed: true, replayed: true })
          }
          return ctx.ok({ key, collection, value: body.value, updatedAt: begun.op.updatedAt, committed: true, replayed: true })
        }
        opId = begun.op.id
      } catch (err) {
        if (err instanceof OpConflictError) {
          throw new V5Error('IDEMPOTENCY_IN_FLIGHT', 'This idempotency key is still being processed.', 409)
        }
        throw err
      }
    }
    const row = await kvSet(ctx.user!.owner, key, body.value, collection)
    if (opId) await completeOp(opId, { key: row.key, collection: row.collection, value: row.value, updatedAt: row.updatedAt })
    return ctx.ok({ key: row.key, collection: row.collection, value: row.value, updatedAt: row.updatedAt, committed: true })
  },
})

export const POST = PUT

export const DELETE = withV5Handler({
  operation: 'kv.delete',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const key = decodeKey((await routeCtx!.params).key)
    const collection = req.nextUrl.searchParams.get('collection') || 'default'
    const wasLive = await kvDelete(ctx.user!.owner, key, collection)
    // DETERMINISTIC PROPAGATION: the queue is throttled per instance — when
    // the delete is the LAST write, a throttled-out queue never ships the
    // tombstone and the id ghosts. Ship the KB-sized kv-delta NOW (bounded,
    // coalesced per instance); the idle-cadence full snapshot reconciles
    // anything the delta races lose. Blobmeta rides the blobs channel.
    // `propagated` tells the caller whether the delta shipped so it can
    // retry (possibly on a healthier instance) when Telegram is flooded.
    let propagated = true
    if (collection !== 'v5_blobmeta') {
      try {
        const { propagateKvDeleteDelta } = await import('@/lib/v5/backup')
        propagated = await Promise.race([
          propagateKvDeleteDelta(),
          new Promise<boolean>((r) => setTimeout(() => r(false), 5000)),
        ])
      } catch {
        propagated = false
      }
    }
    return ctx.ok({ key, collection, deleted: true, wasLive, propagated })
  },
})

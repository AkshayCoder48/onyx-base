/**
 * PUT /api/v5/blobs/:id/parts/:index — upload ONE part of a parts-mode blob
 * (permanent Telegram-backed storage).
 *
 * The raw request body is exactly `chunkSize` bytes (the final part carries
 * the remainder) — the size the server returned at init. The part is stored
 * as a Telegram document IMMEDIATELY (multi-instance safe) and a durable KV
 * part record is written so interrupted uploads resume from exactly the
 * parts that already exist.
 *
 * STATELESS SESSIONS: query params `?size=&cs=&tc=` (the init response the
 * client already holds) let this instance reconstruct the session manifest
 * when init landed on a DIFFERENT instance and the snapshot hasn't converged
 * yet — uploads never block on cross-instance convergence.
 *
 * Idempotent per index: re-PUTting a stored part acknowledges it without
 * re-sending.
 */
import { NextRequest } from 'next/server'
import { withV5Handler } from '@/lib/v5/handler'
import { putBlobPart, type SessionContext } from '@/lib/v5/blob-parts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 120

type Ctx = { params: Promise<{ id: string; index: string }> }

function contextFromQuery(req: NextRequest): SessionContext | null {
  const q = req.nextUrl.searchParams
  const size = Number(q.get('size'))
  const cs = Number(q.get('cs'))
  const tc = Number(q.get('tc'))
  if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(cs) || cs <= 0 || !Number.isInteger(tc) || tc <= 0) {
    return null
  }
  return {
    size,
    chunkSize: cs,
    totalChunks: tc,
    checksum: q.get('sum') || null,
    filename: q.get('fn') || null,
    mimeType: q.get('mime') || null,
  }
}

export const PUT = withV5Handler({
  operation: 'blobs.parts.put',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const { id, index } = await routeCtx!.params
    const idx = Number.parseInt(index, 10)
    const result = await putBlobPart(ctx.user!.owner, id, idx, req.body, contextFromQuery(req))
    return ctx.ok(result)
  },
})

export const POST = PUT

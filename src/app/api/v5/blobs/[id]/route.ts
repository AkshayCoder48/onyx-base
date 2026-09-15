/**
 * /api/v5/blobs/:id — GET metadata / POST|PATCH finalize|cancel (§13-14, §16).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { getBlob, finalizeBlob, cancelBlob } from '@/lib/v5/blobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Ctx = { params: Promise<{ id: string }> }

export const GET = withV5Handler({
  operation: 'blobs.get',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const { id } = await routeCtx!.params
    const blob = await getBlob(id)
    if (!blob || blob.owner !== ctx.user!.owner) throw new V5Error('NOT_FOUND', 'Blob not found.', 404)
    const origin = process.env.PUBLIC_BASE_URL || req.nextUrl.origin
    return ctx.ok({
      blobId: blob.blobId,
      filename: blob.filename,
      mimeType: blob.mimeType,
      size: blob.size,
      checksum: blob.checksum,
      status: blob.status,
      storageKey: blob.storageKey,
      publicUrl: `${origin}/f/${blob.blobId}`,
      createdAt: blob.createdAt,
      updatedAt: blob.updatedAt,
    })
  },
})

export const POST = withV5Handler({
  operation: 'blobs.finalize',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const { id } = await routeCtx!.params
    const body = (await req.json().catch(() => ({}))) as { action?: string }
    const action = body.action || 'finalize'
    if (action === 'cancel') {
      const blob = await cancelBlob(id, ctx.user!.owner)
      return ctx.ok({ blobId: blob.blobId, status: blob.status })
    }
    if (action !== 'finalize') {
      throw new V5Error('VALIDATION_ERROR', 'action must be "finalize" or "cancel".', 400)
    }
    const result = await finalizeBlob(id, ctx.user!.owner)
    return ctx.ok(result)
  },
})

export const PATCH = POST

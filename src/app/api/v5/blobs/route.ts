/**
 * POST /api/v5/blobs — create an upload session (docs/v5-contract.md §11).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { createBlob, V5_CHUNK_SIZE, V5_MAX_CHUNKS, V5_MAX_TOTAL_SIZE } from '@/lib/v5/blobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const POST = withV5Handler({
  operation: 'blobs.create',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    const body = (await req.json().catch(() => ({}))) as {
      filename?: string
      mimeType?: string
      size?: number
    }
    if (body.size !== undefined && (typeof body.size !== 'number' || !Number.isFinite(body.size))) {
      throw new V5Error('VALIDATION_ERROR', 'size must be a number.', 400)
    }
    const blob = await createBlob(ctx.user!.owner, {
      filename: body.filename,
      mimeType: body.mimeType,
      size: body.size,
    })
    return ctx.ok({
      blobId: blob.blobId,
      status: blob.status,
      chunkSize: V5_CHUNK_SIZE,
      maxChunks: V5_MAX_CHUNKS,
      maxTotalSize: V5_MAX_TOTAL_SIZE,
      uploadUrl: `/api/v5/blobs/${blob.blobId}/data`,
    })
  },
})

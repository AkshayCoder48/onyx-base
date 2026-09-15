/**
 * POST /api/v5/blobs — create an upload session (docs/v5-contract.md §11).
 *
 * Two modes:
 *  - legacy (default): single streamed PUT to /data — staging-file based.
 *  - parts (chunked: true): permanent Telegram-backed storage — each part is
 *    PUT to /parts/:index and stored as a Telegram document immediately
 *    (multi-instance safe, resumable, Range-served via /f/:id).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { createBlob, V5_CHUNK_SIZE, V5_MAX_CHUNKS, V5_MAX_TOTAL_SIZE } from '@/lib/v5/blobs'
import { createPartsBlob, V5_PART_SIZE, V5_PARTS_MAX, V5_PARTS_MAX_TOTAL } from '@/lib/v5/blob-parts'

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
      checksum?: string
      chunked?: boolean
      isPublic?: boolean
    }
    if (body.size !== undefined && (typeof body.size !== 'number' || !Number.isFinite(body.size))) {
      throw new V5Error('VALIDATION_ERROR', 'size must be a number.', 400)
    }
    if (body.chunked === true) {
      const session = await createPartsBlob(ctx.user!.owner, {
        filename: body.filename,
        mimeType: body.mimeType,
        size: Math.floor(body.size ?? 0),
        checksum: body.checksum,
        isPublic: body.isPublic,
      })
      return ctx.ok({
        blobId: session.blobId,
        status: session.status,
        mode: 'parts',
        chunkSize: session.chunkSize,
        totalChunks: session.totalChunks,
        maxParts: V5_PARTS_MAX,
        maxTotalSize: V5_PARTS_MAX_TOTAL,
        partUrl: `/api/v5/blobs/${session.blobId}/parts`,
      })
    }
    const blob = await createBlob(ctx.user!.owner, {
      filename: body.filename,
      mimeType: body.mimeType,
      size: body.size,
    })
    return ctx.ok({
      blobId: blob.blobId,
      status: blob.status,
      mode: 'single',
      chunkSize: V5_CHUNK_SIZE,
      maxChunks: V5_MAX_CHUNKS,
      maxTotalSize: V5_MAX_TOTAL_SIZE,
      uploadUrl: `/api/v5/blobs/${blob.blobId}/data`,
    })
  },
})

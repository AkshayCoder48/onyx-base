/**
 * GET /api/v5/blobs/:id/content — stream blob bytes (docs/v5-contract.md §15).
 * ETag = checksum; immutable caching once ready.
 */
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { getBlob, blobContentStream } from '@/lib/v5/blobs'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Ctx = { params: Promise<{ id: string }> }

export const GET = withV5Handler({
  operation: 'blobs.content',
  auth: 'bearer',
  handler: async (req, ctx, routeCtx?: Ctx) => {
    const { id } = await routeCtx!.params
    const blob = await getBlob(id)
    if (!blob || blob.owner !== ctx.user!.owner) throw new V5Error('NOT_FOUND', 'Blob not found.', 404)
    if (blob.status !== 'ready') {
      throw new V5Error('BLOB_NOT_READY', `Blob is '${blob.status}'.`, 409)
    }
    if (req.headers.get('if-none-match') === blob.checksum) {
      return new Response(null, { status: 304, headers: { etag: blob.checksum ?? '' } })
    }
    return new Response(blobContentStream(blob), {
      status: 200,
      headers: {
        'content-type': blob.mimeType || 'application/octet-stream',
        'content-length': String(blob.size),
        etag: blob.checksum ?? '',
        'cache-control': 'public, max-age=31536000, immutable',
        'x-request-id': ctx.requestId,
      },
    })
  },
})

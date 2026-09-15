/**
 * /api/v5/blobs/:id — GET metadata / POST|PATCH finalize|cancel (§13-14, §16).
 *
 * Parts-mode blobs (permanent Telegram-backed storage):
 *  - GET also reports receivedChunks / missingChunks (durable part records)
 *    so interrupted uploads resume from exactly what already exists.
 *  - POST {action:'finalize', parts:[{index, fileId, messageId?}]} verifies
 *    every part reference against Telegram and commits the durable manifest.
 *  - POST {action:'cancel'} deletes the staged Telegram documents.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { getBlob, finalizeBlob, cancelBlob, deleteBlob } from '@/lib/v5/blobs'
import { getPartsStatus, finalizePartsBlob, cancelPartsBlob, deletePartsBlob } from '@/lib/v5/blob-parts'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Ctx = { params: Promise<{ id: string }> }

/** Row lookup with one cross-instance freshness probe on miss (file mode). */
async function getBlobFresh(id: string) {
  let row = await getBlob(id)
  if (!row) {
    try {
      const { ensureFreshness } = await import('@/lib/v5/sync')
      await ensureFreshness()
      row = await getBlob(id)
    } catch {
      /* best-effort */
    }
  }
  return row
}

export const GET = withV5Handler({
  operation: 'blobs.get',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    const { id } = await routeCtx!.params
    // Parts mode? The row's storage_key marker ('parts') routes us.
    const row = await getBlobFresh(id)
    if (row && row.owner === ctx.user!.owner && row.storageKey === 'parts') {
      const status = await getPartsStatus(ctx.user!.owner, id)
      const origin = process.env.PUBLIC_BASE_URL || req.nextUrl.origin
      return ctx.ok({
        blobId: status.blobId,
        mode: 'parts',
        filename: status.filename,
        mimeType: status.mimeType,
        size: status.size,
        checksum: status.checksum,
        status: status.status,
        chunkSize: status.chunkSize,
        totalChunks: status.totalChunks,
        receivedChunks: status.receivedChunks,
        missingChunks: status.missingChunks,
        // Durable part refs — resume clients forward them at finalize
        // (cross-instance bridge: the finalizing instance may not hold the
        // uploading instance's part records yet).
        parts: status.parts,
        publicUrl: status.status === 'ready' ? `${origin}/f/${status.blobId}` : undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    }
    const blob = row
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
    const body = (await req.json().catch(() => ({}))) as {
      action?: string
      parts?: Array<{ index: number; fileId: string; messageId?: number }>
      /** Stateless session context (init response) — lets finalize work on an
       *  instance that never saw init before snapshot convergence. */
      context?: { size?: number; chunkSize?: number; totalChunks?: number; checksum?: string | null; filename?: string | null; mimeType?: string | null }
    }
    const c = body.context
    const ctxValid =
      c && typeof c.size === 'number' && typeof c.chunkSize === 'number' && typeof c.totalChunks === 'number'
        ? { size: c.size, chunkSize: c.chunkSize, totalChunks: c.totalChunks, checksum: c.checksum ?? null, filename: c.filename ?? null, mimeType: c.mimeType ?? null }
        : null
    const action = body.action || 'finalize'
    const row = await getBlobFresh(id)

    // Parts mode routing (storage_key marker). A declared session context
    // also routes parts-mode when the row hasn't converged to this instance
    // yet (stateless finalize — see blob-parts.ts).
    const isPartsMode =
      (row && row.owner === ctx.user!.owner && row.storageKey === 'parts') ||
      (!row && ctxValid !== null)
    if (isPartsMode) {
      if (action === 'cancel') {
        const result = await cancelPartsBlob(ctx.user!.owner, id)
        return ctx.ok({ blobId: result.blobId, status: result.status, deletedDocs: result.deletedDocs })
      }
      if (action !== 'finalize') {
        throw new V5Error('VALIDATION_ERROR', 'action must be "finalize" or "cancel".', 400)
      }
      const result = await finalizePartsBlob(ctx.user!.owner, id, body.parts ?? [], ctxValid)
      return ctx.ok({
        blobId: result.blobId,
        status: result.status,
        url: result.url,
        alreadyProcessed: result.alreadyProcessed,
        dedupOf: result.dedupOf,
        size: result.size,
        checksum: result.checksum,
        totalChunks: result.totalChunks,
      })
    }

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

/**
 * DELETE /api/v5/blobs/:id — PERMANENT storage delete (any status):
 *   - parts mode: Telegram part documents + manifest/part/dedup KV rows +
 *     row tombstone, shipped on the fast blobs channel so /f/:id 404s on
 *     every instance within seconds.
 *   - staging mode: local staging file + row tombstone.
 * Idempotent: 404 when the id is unknown; an already-deleted blob is 200.
 */
export const DELETE = withV5Handler({
  operation: 'blobs.delete',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx, routeCtx?: Ctx) => {
    void req
    const { id } = await routeCtx!.params
    // Fresh row lookup — a just-finalized blob may live on another instance
    // (file-mode convergence); force ONE probe before declaring 404.
    let row = await getBlob(id)
    if (!row || row.owner !== ctx.user!.owner) {
      try {
        const { ensureFreshness } = await import('@/lib/v5/sync')
        await ensureFreshness({ force: true })
        row = await getBlob(id)
      } catch {
        /* best-effort */
      }
    }
    if (!row || row.owner !== ctx.user!.owner) {
      throw new V5Error('NOT_FOUND', 'Blob not found.', 404)
    }
    if (row.storageKey === 'parts') {
      const result = await deletePartsBlob(ctx.user!.owner, id)
      return ctx.ok({
        blobId: result.blobId,
        status: result.status,
        deleted: true,
        deletedDocs: result.deletedDocs,
        deletedMeta: result.deletedMeta,
      })
    }
    const result = await deleteBlob(id, ctx.user!.owner)
    return ctx.ok({ blobId: result.blobId, status: result.status, deleted: true })
  },
})

/**
 * POST /api/v5/kv/batch — atomic multi-upsert (docs/v5-contract.md §4).
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { kvSetBatch } from '@/lib/v5/kv'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const POST = withV5Handler({
  operation: 'kv.batch',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    const body = (await req.json().catch(() => null)) as {
      collection?: string
      items?: Array<{ key: string; value: unknown }>
    } | null
    const items = body?.items
    if (!Array.isArray(items) || items.length === 0) {
      throw new V5Error('VALIDATION_ERROR', 'Body must include a non-empty "items" array.', 400)
    }
    for (const item of items) {
      if (typeof item?.key !== 'string' || !item.key || item.key.length > 512) {
        throw new V5Error('VALIDATION_ERROR', 'Every item needs a string key (≤512 chars).', 400)
      }
    }
    const collection = (body?.collection || 'default').slice(0, 128)
    const count = await kvSetBatch(ctx.user!.owner, items, collection)
    return ctx.ok({ count, committed: true })
  },
})

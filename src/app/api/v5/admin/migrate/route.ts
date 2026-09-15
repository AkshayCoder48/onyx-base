/**
 * POST /api/v5/admin/migrate — V4 → V5 import (docs/v5-contract.md §20).
 * Admin/master keys only. Idempotent snapshot import + backfill.
 */
import { NextRequest } from 'next/server'
import { withV5Handler, V5Error } from '@/lib/v5/handler'
import { migrateFromV4 } from '@/lib/v5/migrate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

export const POST = withV5Handler({
  operation: 'admin.migrate',
  auth: 'bearer',
  handler: async (req: NextRequest, ctx) => {
    if (ctx.user!.role !== 'admin') {
      throw new V5Error('AUTH_REQUIRED', 'Migration requires an admin/master key.', 403)
    }
    const body = (await req.json().catch(() => ({}))) as {
      source?: { baseUrl?: string; apiKey?: string }
      collections?: string[]
      dryRun?: boolean
    }
    const report = await migrateFromV4(ctx.user!.owner, {
      source:
        body.source?.baseUrl && body.source?.apiKey
          ? { baseUrl: body.source.baseUrl, apiKey: body.source.apiKey }
          : undefined,
      collections: body.collections,
      dryRun: body.dryRun,
    })
    return ctx.ok(report)
  },
})

/**
 * GET /api/v5/health/ready — readiness probe (V5 engine reachable).
 */
import { withV5Handler } from '@/lib/v5/handler'
import { v5Configured, v5Ping } from '@/lib/v5/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withV5Handler({
  operation: 'health.ready',
  auth: 'none',
  handler: async (_req, ctx) => {
    if (!v5Configured()) {
      return new Response(
        JSON.stringify({ ok: false, component: 'v5', detail: 'V5_DATABASE_URL not set', requestId: ctx.requestId }),
        { status: 503, headers: { 'content-type': 'application/json', 'x-request-id': ctx.requestId } }
      )
    }
    const ping = await v5Ping()
    if (!ping.ok) {
      return new Response(
        JSON.stringify({ ok: false, component: 'v5-db', detail: 'SELECT 1 failed', requestId: ctx.requestId }),
        { status: 503, headers: { 'content-type': 'application/json', 'x-request-id': ctx.requestId } }
      )
    }
    return ctx.ok({ ok: true, latencyMs: ping.latencyMs })
  },
})

import { withApiHandler } from '@/lib/with-api-handler'
import { authenticate, getPublicOrigin } from '@/lib/auth'
import { v6Ok } from '@/lib/v6'
import { listKeysWithRehydrate } from '@/lib/kv'
import {
  listApiKeys,
  listCollections,
  listLogs,
  listShareTokens,
  getStats,
  getAnalytics,
  listFileRecords,
  publicShareTokenView,
} from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /api/v6/boot — one-shot dashboard hydration (V6 Ultima).
 *
 * Returns EVERYTHING the dashboard needs at boot in a single response:
 * session identity, records, stats, analytics, collections, api keys,
 * share tokens and recent logs. Carries a strong ETag so a client with a
 * current cached copy gets an empty 304 — a fully instant boot from
 * localStorage with zero payload transfer.
 *
 * This replaces the old boot storm (8+ parallel function invocations) with
 * ONE invocation — fewer cold starts, less CPU, faster time-to-paint.
 */
export const GET = withApiHandler({
  operation: 'v6.boot',
  requireAuth: true,
  handler: async (req, ctx) => {
    if (!ctx.user) return ctx.fail('Unauthorized.', 401)
    const user = ctx.user

    const records = await listKeysWithRehydrate(user, undefined)
    const stats = getStats(user.dbUserId)
    const analytics = getAnalytics(user.dbUserId)
    const collections = listCollections(user.dbUserId).map((c) => ({
      id: c.name, // collections are derived; use name as id (matches /api/dashboard/collections)
      name: c.name,
      records: c.records,
      createdAt: c.createdAt,
    }))
    const apiKeys = listApiKeys(user.dbUserId)
    const shareTokens = listShareTokens(user.dbUserId)
    const logs = listLogs(user.dbUserId, { limit: 60 }).map((l) => ({
      id: l.id,
      action: l.action,
      key: l.key,
      detail: l.detail,
      source: l.source,
      ip: l.ip,
      createdAt: l.createdAt,
    }))
    const files = listFileRecords(user.dbUserId)

    const origin = getPublicOrigin(req)
    const payload = {
      v: 6 as const,
      arch: 'ultima' as const,
      // NOTE: no per-request timestamps in the payload — the ETag covers it,
      // and a clock field would invalidate the tag on every boot. The boot
      // time rides along as a response header instead.
      session: {
        userId: user.userId,
        apiKeyName: user.apiKeyName,
        isAdmin: user.isAdmin,
        counts: {
          records: stats.records,
          collections: stats.collections,
          apiKeys: stats.apiKeys,
          logs: stats.logs,
        },
      },
      records: {
        records,
        count: records.length,
      },
      stats,
      analytics,
      collections: { collections },
      apiKeys: { apiKeys },
      shareTokens: { shareTokens: shareTokens.map((t) => publicShareTokenView(t, origin)) },
      logs: { logs },
      files: { count: files.length, bytes: files.reduce((s, f) => s + f.size, 0) },
    }

    if (process.env.NODE_ENV !== 'production') {
      ctx.log({ op: 'v6.boot', records: records.length, keys: apiKeys.length })
    }

    return v6Ok(payload, req.headers.get('if-none-match'))
  },
})

import { NextRequest } from 'next/server'
import { withPublicApiHandler, type ApiHandlerCtx } from '@/lib/with-api-handler'
import { isTelegramConfigured, pingTelegram } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * GET /api/health
 *
 * Component-level health check. Returns the status of every subsystem the
 * dashboard depends on:
 *   - api       — this Next.js process (always healthy if we're responding)
 *   - database  — the local JSON cache (and on demand, the SQLite index)
 *   - telegram  — reachability of the Telegram Bot API + the configured chat
 *   - realtime  — the socket.io mini-service on port 3003
 *
 * Status values:
 *   - healthy    — fully operational
 *   - degraded    — partially functional (e.g. Telegram probe succeeded but
 *                   with a slow response, or the realtime service is
 *                   temporarily unreachable)
 *   - unhealthy   — subsystem is down; user-facing operations will fail
 *
 * This endpoint does NOT require authentication so it can be used by load
 * balancers / uptime monitors. It NEVER returns secrets (bot tokens, chat
 * IDs, user data).
 */
export const GET = withPublicApiHandler('health.check', async (req: NextRequest, ctx: ApiHandlerCtx) => {
  const start = Date.now()

  // 1. API process — we're alive if we're responding.
  const apiStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy'

  // 2. Database (local JSON cache). We can't import data-store here without
  //    pulling in the whole rehydrate chain — instead, just stat the file.
  let databaseStatus: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy'
  let dbDetail = ''
  try {
    const fs = await import('fs')
    const path = await import('path')
    const isServerless = !!process.env.VERCEL || !!process.env.CF_PAGES || !!process.env.CLOUDFLARE
    const dataDir = isServerless ? '/tmp' : path.join(process.cwd(), 'db')
    const storePath = path.join(dataDir, 'cloudkv.json')
    if (fs.existsSync(storePath)) {
      const stat = fs.statSync(storePath)
      const ageMs = Date.now() - stat.mtimeMs
      // If the cache hasn't been touched in 24h, that's suspicious — degraded.
      databaseStatus = ageMs < 24 * 60 * 60 * 1000 ? 'healthy' : 'degraded'
      dbDetail = `last write ${Math.round(ageMs / 1000)}s ago`
    } else {
      databaseStatus = 'degraded'
      dbDetail = 'cache file does not exist yet (cold boot)'
    }
  } catch (err) {
    dbDetail = err instanceof Error ? err.message : 'cache stat failed'
  }

  // 3. Telegram — only check if configured. Use the env-default chat (no auth
  //    context here, so we can't probe per-user configs).
  let telegramStatus: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy'
  let telegramDetail = ''
  const envChat = process.env.TELEGRAM_CHAT_ID || ''
  const envBot = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!envChat || !envBot) {
    telegramStatus = 'degraded'
    telegramDetail = 'env defaults not set (per-user overrides may still work)'
  } else if (!isTelegramConfigured(envChat, envBot)) {
    telegramStatus = 'unhealthy'
    telegramDetail = 'env defaults incomplete (bot token or chat ID missing)'
  } else {
    try {
      const probe = await pingTelegram(envChat, envBot, process.env.TELEGRAM_BOT_API_URL)
      if (probe.ok) {
        telegramStatus = 'healthy'
        telegramDetail = `chat reachable (type: ${probe.chatType ?? 'unknown'})`
      } else {
        telegramStatus = 'degraded'
        telegramDetail = probe.error ?? 'probe failed'
      }
    } catch (err) {
      telegramStatus = 'unhealthy'
      telegramDetail = err instanceof Error ? err.message : 'probe failed'
    }
  }

  // 4. Realtime (socket.io mini-service on port 3003).
  let realtimeStatus: 'healthy' | 'degraded' | 'unhealthy' = 'unhealthy'
  let realtimeDetail = ''
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1500)
    const res = await fetch('http://localhost:3003/health', { signal: controller.signal }).catch(() => null)
    clearTimeout(timer)
    if (res && res.ok) {
      realtimeStatus = 'healthy'
      realtimeDetail = 'socket.io mini-service responding'
    } else if (res) {
      realtimeStatus = 'degraded'
      realtimeDetail = `mini-service returned ${res.status}`
    } else {
      realtimeStatus = 'degraded'
      realtimeDetail = 'mini-service not responding (realtime disabled)'
    }
  } catch {
    realtimeStatus = 'degraded'
    realtimeDetail = 'mini-service unreachable (realtime disabled, app still works)'
  }

  const components = {
    api: apiStatus,
    database: databaseStatus,
    telegram: telegramStatus,
    realtime: realtimeStatus,
  }

  const overall =
    Object.values(components).every((s) => s === 'healthy')
      ? 'healthy'
      : Object.values(components).some((s) => s === 'unhealthy')
        ? 'unhealthy'
        : 'degraded'

  const elapsedMs = Date.now() - start
  ctx.log({ stage: 'health.check', overall, elapsedMs, components })

  // ALWAYS return 200 — the `status` field carries the actual health state.
  // The Diagnostics view fetches this and reads `components.*` to render the
  // per-subsystem tiles. Returning 503 here would make the client-side
  // `api()` wrapper throw, hiding the components data from the UI (the
  // user wouldn't be able to see WHICH component was unhealthy).
  // Load balancers that need a 503 to drain traffic can probe a separate
  // /api/livez endpoint (added below).
  return ctx.ok({
    status: overall,
    components,
    details: {
      api: 'process responding',
      database: dbDetail,
      telegram: telegramDetail,
      realtime: realtimeDetail,
    },
    timestamp: new Date().toISOString(),
    elapsedMs,
  })
})

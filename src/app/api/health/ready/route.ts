import { NextRequest } from 'next/server'
import { withPublicApiHandler, type ApiHandlerCtx } from '@/lib/with-api-handler'
import { withRequestId } from '@/lib/request-id'
import { isTelegramConfigured, pingTelegram } from '@/lib/telegram'

export const runtime = 'nodejs'

/** Cap on the Telegram probe so the readiness answer stays cheap (~≤3s). */
const TELEGRAM_PROBE_TIMEOUT_MS = 3000

/**
 * GET /api/health/ready — readiness probe (Kubernetes convention).
 *
 * "Should this instance receive traffic?" — 200 when both critical
 * components are up, 503 with `{ ok: false, component }` when not:
 *
 *   - store    — the in-memory storage engine is loaded (the data-store
 *                module initialized without crashing). A missing/stale local
 *                JSON cache is NOT unready: Telegram is the durable layer and
 *                accounts rehydrate on demand, so the cache state is only
 *                reported as informational detail.
 *   - telegram — the durable backend answers for the env-default bot+chat
 *                (getMe + getChat via the existing pingTelegram). No secrets
 *                are returned — pingTelegram's errors are already scrubbed.
 *
 * Unauthenticated and cheap by design (load balancers / uptime monitors).
 * No full exports, no store scans, no per-user probes. For a component
 * breakdown (incl. realtime) use /api/health; for pure process liveness use
 * /api/livez.
 */
export const GET = withPublicApiHandler('health.ready', async (req: NextRequest, ctx: ApiHandlerCtx) => {
  const start = Date.now()

  // 1. Store — dynamic import proves the engine module initialized; touching
  //    a cheap exported getter proves it is callable. If module init ever
  //    crashes, this returns a 503 instead of an opaque 500.
  let storeReady = false
  let storeDetail = 'engine loaded'
  try {
    const ds = await import('@/lib/data-store')
    void ds.isV4ModeActive()
    storeReady = true
    // Informational only (same probe /api/health uses): local cache state.
    try {
      const fs = await import('fs')
      const path = await import('path')
      const isServerless = !!process.env.VERCEL || !!process.env.CF_PAGES || !!process.env.CLOUDFLARE
      const storePath = path.join(isServerless ? '/tmp' : path.join(process.cwd(), 'db'), 'cloudkv.json')
      storeDetail = fs.existsSync(storePath)
        ? 'engine loaded, local cache present'
        : 'engine loaded, local cache cold (Telegram rehydrates on demand)'
    } catch {
      /* keep the default detail */
    }
  } catch (err) {
    storeDetail = err instanceof Error ? err.message : 'data-store failed to initialize'
  }

  // 2. Telegram — env-default configuration + live probe, time-boxed.
  let telegramReady = false
  let telegramDetail = ''
  const envChat = process.env.TELEGRAM_CHAT_ID || ''
  const envBot = process.env.TELEGRAM_BOT_TOKEN || ''
  if (!envChat || !envBot || !isTelegramConfigured(envChat, envBot)) {
    telegramDetail = 'env-default Telegram config incomplete (TELEGRAM_CHAT_ID / TELEGRAM_BOT_TOKEN)'
  } else {
    let probe: Awaited<ReturnType<typeof pingTelegram>> | null = null
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), TELEGRAM_PROBE_TIMEOUT_MS)
      })
      probe = await Promise.race([
        pingTelegram(envChat, envBot, process.env.TELEGRAM_BOT_API_URL),
        timeout,
      ])
      if (timer) clearTimeout(timer)
    } catch {
      probe = null
    }
    if (probe === null) {
      telegramDetail = `Bot API unreachable (probe capped at ${TELEGRAM_PROBE_TIMEOUT_MS / 1000}s)`
    } else if (probe.ok) {
      telegramReady = true
      telegramDetail = `chat reachable (type: ${probe.chatType ?? 'unknown'})`
    } else {
      telegramDetail = probe.error ?? 'probe failed'
    }
  }

  const elapsedMs = Date.now() - start
  ctx.log({ stage: 'health.ready', storeReady, telegramReady, elapsedMs })

  if (!storeReady) {
    return Response.json(
      { ok: false, component: 'store', detail: storeDetail, requestId: ctx.requestId },
      withRequestId(ctx.requestId, { status: 503 }),
    )
  }
  if (!telegramReady) {
    return Response.json(
      { ok: false, component: 'telegram', detail: telegramDetail, requestId: ctx.requestId },
      withRequestId(ctx.requestId, { status: 503 }),
    )
  }
  return ctx.ok({ store: storeDetail, telegram: telegramDetail, elapsedMs })
})

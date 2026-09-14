export const runtime = 'nodejs'

/**
 * GET /api/livez — liveness probe (Kubernetes convention).
 *
 * Answers ONE question only: "is this process able to serve HTTP?" If this
 * returns non-200, the runtime is wedged and the instance should be
 * restarted. It therefore has ZERO dependencies — no auth, no store, no
 * Telegram, no fs, no imports — so it stays fast and always truthful even
 * when every subsystem is degraded.
 *
 * For a full component breakdown use /api/health; for "should this instance
 * receive traffic?" (store loaded + Telegram reachable) use /api/health/ready.
 */
export function GET() {
  return Response.json({ ok: true })
}

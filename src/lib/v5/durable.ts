/**
 * OnyxBase V5 — durable background work (serverless freeze fix).
 *
 * THE PROBLEM
 *   On Vercel, a serverless function may be FROZEN the moment its response is
 *   sent. Fire-and-forget promises (void doAsync()) are killed mid-flight:
 *   the auth snapshot after a registration never reached Telegram, so the
 *   account existed only on the instance that created it — the next login on
 *   a different instance honestly answered AUTH_INVALID_CREDENTIALS. That is
 *   the exact commit-vs-response desync class V5 exists to eliminate.
 *
 * THE FIX
 *   `waitUntil` from @vercel/functions registers a promise on the CURRENT
 *   invocation: the platform keeps the function alive until the promise
 *   settles (bounded by the route's maxDuration). The HTTP response is NOT
 *   delayed — only the function's lifetime is extended.
 *
 * Usage rules:
 *   - Call durable() SYNCHRONOUSLY within a request handler's async context
 *     (not from a setTimeout that outlives the request) so the promise is
 *     registered on the right invocation.
 *   - Promises must never reject (attach internal catches).
 *
 * Non-Vercel environments (local dev, self-hosted standalone server) never
 * freeze mid-task: durable() degrades to a plain void.
 */

import { waitUntil } from '@vercel/functions'

const IS_VERCEL = !!process.env.VERCEL

/** Keep the current invocation alive until `p` settles. Never throws. */
export function durable(p: Promise<unknown>): void {
  void p.catch(() => {
    /* callers handle their own errors; this only marks the chain handled */
  })
  if (!IS_VERCEL) return
  try {
    waitUntil(p.catch(() => undefined))
  } catch {
    // Outside a request context (boot, timers) — nothing to attach to.
  }
}

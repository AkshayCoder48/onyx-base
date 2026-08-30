import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getRawMcpeConfig, resolveSubject, resolveBody } from '@/lib/mcpemail-config'
import { sendEmailViaMcpe, McpeError } from '@/lib/mcpemail'
import { issueOtp, OTP_TTL_MS } from '@/lib/otp-store'

export const runtime = 'nodejs'

// ── Per-IP rate limit (in-memory, not persisted) ────────────────────────────
// OTP send abuse protection. The same IP can request at most 5 OTPs within
// a 10-minute sliding window. This is best-effort: on a serverless platform
// without sticky sessions, a determined attacker can bypass this by hitting
// different instances — but it stops the trivial "spam the endpoint" attack.
const ipBuckets = new Map<string, number[]>() // ip → array of timestamps
const WINDOW_MS = 10 * 60 * 1000 // 10 min
const MAX_PER_WINDOW = 5

function checkIp(ip: string): { ok: true } | { ok: false; retryAfter: number } {
  const now = Date.now()
  let hits = ipBuckets.get(ip) ?? []
  hits = hits.filter((t) => now - t < WINDOW_MS)
  if (hits.length >= MAX_PER_WINDOW) {
    const oldest = hits[0]
    const retryAfter = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000))
    ipBuckets.set(ip, hits)
    return { ok: false, retryAfter }
  }
  hits.push(now)
  ipBuckets.set(ip, hits)
  return { ok: true }
}

// Garbage-collect the ipBuckets map every minute so it doesn't grow unbounded.
// This is a serverless-friendly pattern: each cold boot starts fresh, and
// long-lived dev-server instances don't leak memory.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [ip, hits] of ipBuckets) {
      const fresh = hits.filter((t) => now - t < WINDOW_MS)
      if (fresh.length === 0) ipBuckets.delete(ip)
      else ipBuckets.set(ip, fresh)
    }
  }, 60_000).unref?.()
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * POST /api/email-otp/send
 * Body: { "email": "user@example.com", "subject"?, "body"?, "fromName"? }
 *
 * Generates a 6-digit OTP, stores it as a hashed record (10-min TTL),
 * and sends it to the recipient via the user's stored MCPEmail API key.
 *
 * Auth: the caller must present a valid Onyx Base API key (kv_live_*
 * or onyxbase_*). The MCPEmail API key is read from the caller's own
 * config — so each tenant pays for their own email sends.
 *
 * Returns 200 + { ok:true, expiresAt, ttl } on success.
 * Returns 429 on per-IP rate limit (with Retry-After header).
 * Returns 400 on bad email / no MCPEmail config / MCPEmail send failure.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  // Per-IP throttle.
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  const ipCheck = checkIp(ip)
  if (!ipCheck.ok) {
    return fail(
      `Too many OTP requests from this IP. Retry after ${ipCheck.retryAfter}s.`,
      429,
      { code: 'rate_limited', 'Retry-After': String(ipCheck.retryAfter) },
    )
  }

  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email || !EMAIL_RE.test(email)) {
    return fail('A valid email address is required.', 400, { code: 'bad_email' })
  }

  // Load the caller's MCPEmail config.
  const cfg = getRawMcpeConfig(user.dbUserId)
  if (!cfg) {
    return fail(
      'No MCPEmail API key configured. Open the dashboard → Email OTP tab and paste your mcpe_live_* key first.',
      400,
      { code: 'no_mcpe_config' },
    )
  }

  // Issue the OTP FIRST. This means even if the email send fails, the OTP
  // is in the store — the user can retry the send (the OTP just expires
  // unused). Doing it in the other order (send email first, then store)
  // would leave the user with a code in their inbox but no record to
  // verify against — much worse.
  const { code, expiresAt } = issueOtp(user.dbUserId, user.userId, email)

  // Build the email contents. Per-call overrides (subject/body/fromName)
  // take precedence over the stored templates — useful for developers who
  // want to localize or re-brand on a per-request basis.
  const subject =
    typeof body.subject === 'string' && body.subject.trim()
      ? body.subject.trim().replace(/\$CODE/g, code)
      : resolveSubject(cfg, code)
  const emailBody =
    typeof body.body === 'string' && body.body.trim()
      ? body.body.trim().replace(/\$CODE/g, code)
      : resolveBody(cfg, code)

  try {
    await sendEmailViaMcpe(cfg.apiKey, {
      to: email,
      subject,
      body: emailBody,
    })
  } catch (err) {
    // Best-effort cleanup: delete the OTP record so a follow-up verify
    // doesn't return "not_found" — that would be misleading. With the
    // record gone, the user can immediately retry and get a fresh OTP.
    // (We don't delete on success because verify needs it.)
    const { voidOtp } = await import('@/lib/otp-store')
    voidOtp(user.dbUserId, email)

    if (err instanceof McpeError) {
      return fail(
        `MCPEmail send failed: ${err.message}`,
        502,
        { code: err.code ?? 'mcpe_error', mcpeStatus: err.status },
      )
    }
    return fail(
      `Could not send OTP email: ${err instanceof Error ? err.message : String(err)}`,
      502,
      { code: 'send_failed' },
    )
  }

  return ok({
    expiresAt,
    ttl: OTP_TTL_MS,
    // Exposed for the developer's benefit when testing in dev — they can
    // read the code from the response without checking email. In prod,
    // the caller never sees this since the field is omitted when not
    // running against localhost. (We always include it for now — being
    // explicit is more honest than hiding it.)
    ...(process.env.NODE_ENV !== 'production' ? { _devCode: code } : {}),
  })
}

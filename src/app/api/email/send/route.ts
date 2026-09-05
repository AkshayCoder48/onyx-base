import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, fail } from '@/lib/auth'
import { orchestrateEmailSend } from '@/lib/email-automation'
import { consumeIpRateLimit, clientIpFrom } from '@/lib/email-rate-limit'
import { newRequestId } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * POST /api/email/send — the Email Automation send endpoint (PRD §7–§8).
 *
 * Auth: `Authorization: Bearer <PLATFORM API KEY>` (kv_live_* / onyxbase_*).
 * The platform key authenticates the caller against THIS API only — it is
 * NEVER forwarded to MCPEmail. The MCPEmail hop is authenticated with the
 * caller's own named credential (resolved from their private store).
 *
 * Body:
 *   {
 *     "credential": "personal_email",       // required — credential NAME
 *     "to": "user@example.com",             // or ["a@x.com", "b@x.com"]
 *     "subject": "Welcome $NAME$",          // $VAR_NAME$ substitution
 *     "body": "Hello $NAME$,\n\nYour code is $OTP$.",
 *     "htmlBody": "<p>Hello $NAME$…</p>",   // optional
 *     "variables": { "NAME": "Akshay", "OTP": "483921" },
 *     "fromName": "My App"                  // optional per-send override
 *   }
 *
 * Responses (all carry `request_id` + `X-Request-Id` header):
 *   200 { ok, success, message, request_id, credential, recipients,
 *        variables_applied, latency_ms, upstream_message_id? }
 *   400 bad_request / bad_recipient / missing_variable { variable, field }
 *   401 invalid_api_key          403 insufficient_scope
 *   404 credential_not_found     429 rate_limited
 *   502 upstream_authentication_failed / upstream_error / upstream_rate_limited
 *   504 upstream_timeout
 *
 * The response NEVER contains the MCPEmail key (or any credential material).
 */
export async function POST(req: NextRequest) {
  // ── 1. Platform API key authentication ──────────────────────────────────
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) {
    return fail(
      'Unauthorized. Pass your Onyx Base platform API key (kv_live_*) as a Bearer token. This is the platform key — NOT the MCPEmail key.',
      401,
      { code: 'invalid_api_key' },
    )
  }
  const z = authorize(user, req, { scope: 'write' })
  if (!z.ok) return authorizeFailResponse(z)

  const requestId = newRequestId()

  // ── 2. Per-IP spam guard ────────────────────────────────────────────────
  const ip = clientIpFrom(req)
  const ipCheck = consumeIpRateLimit(ip)
  if (!ipCheck.ok) {
    return fail(
      `Too many email requests from this IP. Retry after ${ipCheck.retryAfter}s.`,
      429,
      { code: 'rate_limited', request_id: requestId, 'Retry-After': String(ipCheck.retryAfter) },
    )
  }

  // ── 3. Parse + orchestrate ──────────────────────────────────────────────
  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return fail('A JSON body is required.', 400, { code: 'bad_request', request_id: requestId })
  }

  return orchestrateEmailSend(user, {
    credential: typeof body.credential === 'string' ? body.credential : '',
    to: body.to,
    subject: typeof body.subject === 'string' ? body.subject : '',
    body: typeof body.body === 'string' ? body.body : undefined,
    htmlBody: typeof body.htmlBody === 'string' ? body.htmlBody : undefined,
    variables: body.variables && typeof body.variables === 'object' ? body.variables : undefined,
    fromName: typeof body.fromName === 'string' ? body.fromName : undefined,
    requestId,
    endpoint: '/api/email/send',
  })
}

export function GET() {
  return fail('Method not allowed. Use POST.', 405, { code: 'method_not_allowed' })
}

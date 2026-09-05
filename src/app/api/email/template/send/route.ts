import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, fail } from '@/lib/auth'
import { orchestrateEmailSend } from '@/lib/email-automation'
import { getRawTemplate } from '@/lib/email-templates'
import { consumeIpRateLimit, clientIpFrom } from '@/lib/email-rate-limit'
import { newRequestId, scrubSecrets } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * POST /api/email/template/send — send using a STORED template by name
 * (PRD §11–§12: one template, different variables per request).
 *
 * Body:
 *   {
 *     "credential": "personal_email",
 *     "template": "welcome",                // stored template name
 *     "to": "user@example.com",
 *     "variables": { "NAME": "Akshay", "OTP": "483921" },
 *     "fromName": "My App"                  // optional override
 *   }
 *
 * Inline form (no stored template needed):
 *   {
 *     "credential": "personal_email",
 *     "template": { "subject": "Hi $NAME$", "body": "Code: $OTP$", "htmlBody": null },
 *     "to": "user@example.com",
 *     "variables": { "NAME": "Akshay", "OTP": "483921" }
 *   }
 *
 * The stored template is NEVER modified — variables are substituted per
 * request only. Same response/error contract as POST /api/email/send, plus:
 *   404 template_not_found
 */
export async function POST(req: NextRequest) {
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

  const ip = clientIpFrom(req)
  const ipCheck = consumeIpRateLimit(ip)
  if (!ipCheck.ok) {
    return fail(
      `Too many email requests from this IP. Retry after ${ipCheck.retryAfter}s.`,
      429,
      { code: 'rate_limited', request_id: requestId, 'Retry-After': String(ipCheck.retryAfter) },
    )
  }

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return fail('A JSON body is required.', 400, { code: 'bad_request', request_id: requestId })
  }

  // ── Resolve the template (by name, or inline object) ────────────────────
  let subject = ''
  let tplBody: string | undefined
  let tplHtml: string | undefined

  const tpl = body.template
  if (typeof tpl === 'string' && tpl.trim()) {
    const stored = getRawTemplate(user.dbUserId, tpl.trim())
    if (!stored) {
      return fail(
        `Template "${scrubSecrets(tpl).slice(0, 64)}" was not found for this account. Save it first via POST /api/email/templates.`,
        404,
        { code: 'template_not_found', request_id: requestId },
      )
    }
    subject = stored.subject
    tplBody = stored.body
    tplHtml = stored.htmlBody ?? undefined
  } else if (tpl && typeof tpl === 'object' && !Array.isArray(tpl)) {
    const t = tpl as { subject?: unknown; body?: unknown; htmlBody?: unknown }
    subject = typeof t.subject === 'string' ? t.subject : ''
    tplBody = typeof t.body === 'string' ? t.body : undefined
    tplHtml = typeof t.htmlBody === 'string' ? t.htmlBody : undefined
  } else {
    return fail(
      'A "template" is required: either a stored template name (string) or an inline { subject, body, htmlBody? } object.',
      400,
      { code: 'bad_request', request_id: requestId },
    )
  }

  // Per-request overrides still win (subject/body/htmlBody fields on the
  // request override the template's fields — useful for last-mile tweaks).
  if (typeof body.subject === 'string' && body.subject.trim()) subject = body.subject
  if (typeof body.body === 'string' && body.body.trim()) tplBody = body.body
  if (typeof body.htmlBody === 'string' && body.htmlBody.trim()) tplHtml = body.htmlBody

  return orchestrateEmailSend(user, {
    credential: typeof body.credential === 'string' ? body.credential : '',
    to: body.to,
    subject,
    body: tplBody,
    htmlBody: tplHtml,
    variables: body.variables && typeof body.variables === 'object' ? body.variables : undefined,
    fromName: typeof body.fromName === 'string' ? body.fromName : undefined,
    requestId,
    endpoint: '/api/email/template/send',
  })
}

export function GET() {
  return fail('Method not allowed. Use POST.', 405, { code: 'method_not_allowed' })
}

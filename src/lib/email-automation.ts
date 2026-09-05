/**
 * Onyx Base — Email Automation orchestrator (PRD §6–§8, §29).
 *
 * THE CREDENTIAL BOUNDARY (the most important rule in the system):
 *
 *   PLATFORM API KEY (kv_live_*)          MCPEmail KEY (mcpe_*)
 *   ─────────────────────────             ─────────────────────────
 *   authenticates: user → OUR API        authenticates: OUR API → MCPEmail
 *   checked by authenticate()             resolved by name from the USER's
 *   NEVER forwarded upstream              credential store (never echoed,
 *                                         never a project-wide fallback)
 *
 * Pipeline for every send:
 *   1. authenticate()  — platform key (done by the route before calling us)
 *   2. validate request shape (to / subject / body)
 *   3. resolve `credential` BY NAME from the caller's own store → FAIL CLOSED
 *      (credential_not_found) — there is NO project-wide key fallback
 *   4. render $VAR_NAME$ variables → missing_variable aborts the send
 *   5. per-credential custom rate limit (configurable) → 429 before upstream
 *   6. call MCPEmail with the USER's mcpe_* key (sendEmailViaMcpe)
 *   7. record metadata-only request log entry (request_id, latency, status)
 *   8. return SANITIZED result — never the credential, never raw upstream
 *      error bodies (scrubbed through scrubSecrets)
 */

import type { AuthenticatedUser } from '@/lib/auth'
import { ok, fail } from '@/lib/auth'
import { rehydrateAccountFromTelegram } from '@/lib/data-store'
import { getRawCredential, touchCredentialLastUsed } from '@/lib/email-credentials'
import { renderTemplate, sanitizeVariables, extractVariables } from '@/lib/email-variables'
import { recordEmailRequest } from '@/lib/email-request-log'
import { consumeCredentialRateLimit } from '@/lib/email-rate-limit'
import { sendEmailViaMcpe, McpeError } from '@/lib/mcpemail'
import { isValidMcpeKey } from '@/lib/mcpemail-config'
import { logRequest, scrubSecrets } from '@/lib/request-id'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_SUBJECT = 998
const MAX_BODY = 1_000_000
const MAX_RECIPIENTS = 20

export interface EmailSendInput {
  /** Credential NAME (e.g. "personal_email") — resolved from the caller's store. */
  credential: string
  /** Recipient address(es). */
  to: string | string[]
  subject: string
  /** Plain-text body (required unless htmlBody is provided). */
  body?: string
  /** Optional HTML body. */
  htmlBody?: string
  /** $VAR_NAME$ → value substitutions. */
  variables?: Record<string, unknown>
  /** Per-send sender name override (falls back to the credential's fromName). */
  fromName?: string
  /** Request ID (minted by the route). */
  requestId: string
  /** Endpoint tag for the request log (e.g. '/api/email/send'). */
  endpoint: string
}

export type OrchestrationResult = Response

/** Normalize + validate the request shape. Returns a fail() Response on error. */
function validateInput(input: EmailSendInput): { to: string[]; subject: string } | Response {
  const to = Array.isArray(input.to) ? input.to : [input.to]
  if (to.length === 0) {
    return fail('At least one recipient is required.', 400, { code: 'bad_request' })
  }
  if (to.length > MAX_RECIPIENTS) {
    return fail(`Too many recipients (max ${MAX_RECIPIENTS}).`, 400, { code: 'bad_request' })
  }
  const cleanTo: string[] = []
  for (const addr of to) {
    const t = typeof addr === 'string' ? addr.trim().toLowerCase() : ''
    if (!t || !EMAIL_RE.test(t)) {
      return fail(`Invalid recipient address: ${scrubSecrets(String(addr)).slice(0, 120)}`, 400, {
        code: 'bad_recipient',
      })
    }
    cleanTo.push(t)
  }

  const subject = typeof input.subject === 'string' ? input.subject : ''
  if (!subject.trim()) {
    return fail('Subject is required.', 400, { code: 'bad_request' })
  }
  if (subject.length > MAX_SUBJECT) {
    return fail(`Subject is too long (max ${MAX_SUBJECT} chars).`, 400, { code: 'bad_request' })
  }

  const hasBody = typeof input.body === 'string' && input.body.length > 0
  const hasHtml = typeof input.htmlBody === 'string' && input.htmlBody.length > 0
  if (!hasBody && !hasHtml) {
    return fail('A plain-text body (or HTML body) is required.', 400, { code: 'bad_request' })
  }
  if (hasBody && input.body!.length > MAX_BODY) {
    return fail(`Body is too large (max ${MAX_BODY} chars).`, 400, { code: 'bad_request' })
  }
  if (hasHtml && input.htmlBody!.length > MAX_BODY) {
    return fail(`HTML body is too large (max ${MAX_BODY} chars).`, 400, { code: 'bad_request' })
  }
  return { to: cleanTo, subject }
}

/**
 * Run the full email automation pipeline for an authenticated user.
 * Returns the final API Response (sanitized, request_id-tagged).
 */
export async function orchestrateEmailSend(
  user: AuthenticatedUser,
  input: EmailSendInput,
): Promise<OrchestrationResult> {
  const { requestId, endpoint } = input
  const t0 = Date.now()
  const logFinish = (status: 'sent' | 'failed', errorCode?: string, upstreamStatus?: number) => {
    recordEmailRequest(user.dbUserId, user.userId, {
      requestId,
      ts: new Date().toISOString(),
      endpoint,
      credential: input.credential,
      status,
      latencyMs: Date.now() - t0,
      ...(upstreamStatus ? { upstreamStatus } : {}),
      ...(errorCode ? { errorCode } : {}),
    })
  }

  // ── 1. Shape validation ─────────────────────────────────────────────────
  const validated = validateInput(input)
  if (validated instanceof Response) return validated
  const { to, subject } = validated

  // ── 2. Credential resolution (FAIL CLOSED — PRD §29) ────────────────────
  const credName = (input.credential ?? '').trim()
  if (!credName) {
    return fail('A credential name is required (e.g. "personal_email").', 400, {
      code: 'credential_required',
    })
  }
  let cred = getRawCredential(user.dbUserId, credName)
  if (!cred) {
    // Cross-instance consistency: the credential may exist in the durable
    // Telegram manifest but not yet on THIS warm serverless instance (the
    // platform's documented eventual-consistency model). One-shot
    // rehydrate-on-miss — the exact pattern authenticate() uses for API keys —
    // then re-check. If it still doesn't exist, we FAIL CLOSED below.
    try {
      const rh = await rehydrateAccountFromTelegram(user.userId)
      if (rh.attempted) cred = getRawCredential(user.dbUserId, credName)
    } catch {
      /* network/rehydrate failure — keep null → fail closed */
    }
  }
  if (!cred) {
    return fail(
      `Credential "${scrubSecrets(credName)}" was not found for this account. Connect it first via POST /api/credentials/connect, then reference it by name. There is no project-wide fallback credential.`,
      404,
      { code: 'credential_not_found' },
    )
  }
  // Paranoia: never use a stored credential that fails format validation
  // (e.g. corrupted record) — fail closed, not open.
  if (!isValidMcpeKey(cred.value.apiKey)) {
    return fail(
      `Credential "${scrubSecrets(credName)}" holds a malformed MCPEmail key. Delete and reconnect it.`,
      422,
      { code: 'credential_invalid' },
    )
  }

  // ── 3. Variable rendering ($VAR_NAME$) ──────────────────────────────────
  const variables = sanitizeVariables(input.variables)
  const render = renderTemplate(
    { subject, body: input.body, htmlBody: input.htmlBody },
    variables,
  )
  if (!render.ok) {
    logFinish('failed', 'missing_variable')
    return fail(
      `Variable $${render.variable}$ is used in the ${render.field} but no value was supplied. The email was NOT sent.`,
      400,
      { code: 'missing_variable', variable: render.variable, field: render.field, request_id: requestId },
    )
  }

  // ── 4. Per-credential custom rate limit ─────────────────────────────────
  const rl = consumeCredentialRateLimit(user.dbUserId, credName, cred.value.rateLimitPerMin)
  if (!rl.ok) {
    logFinish('failed', 'rate_limited')
    return fail(
      `MCPEmail send rate limit for credential "${scrubSecrets(credName)}" exceeded (${rl.limit}/min). Retry after ${rl.retryAfter}s.`,
      429,
      { code: 'rate_limited', retryAfter: rl.retryAfter, 'Retry-After': String(rl.retryAfter), request_id: requestId },
    )
  }

  // ── 5. Forward to MCPEmail with the USER'S key ──────────────────────────
  // The platform API key never appears in this call. Only the user's own
  // credential authenticates the upstream hop.
  const fromName = input.fromName?.trim() || cred.value.fromName || undefined
  let upstreamStatus: number | undefined
  try {
    const result = await sendEmailViaMcpe(cred.value.apiKey, {
      to,
      subject: render.rendered.subject,
      body: render.rendered.body ?? '',
      htmlBody: render.rendered.htmlBody,
      ...(fromName ? { fromName } : {}),
    })
    upstreamStatus = 200
    touchCredentialLastUsed(user.dbUserId, user.userId, credName)
    logFinish('sent', undefined, 200)
    logRequest(requestId, 'email.send', {
      endpoint,
      credential: credName,
      recipientCount: to.length,
      variablesApplied: render.rendered.appliedVariables,
      latencyMs: Date.now() - t0,
      status: 'sent',
    })
    return ok({
      success: true,
      message: 'Email request completed',
      request_id: requestId,
      credential: credName,
      recipients: to.length,
      variables_applied: render.rendered.appliedVariables,
      latency_ms: Date.now() - t0,
      upstream_message_id: result.messageId,
    })
  } catch (err) {
    // ── 6. Sanitized failure mapping (PRD §20) ────────────────────────────
    let status = 502
    let code = 'upstream_error'
    let message = 'MCPEmail request failed.'
    if (err instanceof McpeError) {
      upstreamStatus = err.status
      if (err.status === 401 || err.status === 403) {
        code = 'upstream_authentication_failed'
        status = 502
        message = `MCPEmail rejected the credential "${scrubSecrets(credName)}" (authentication failed). Verify the key still matches your mcpemails.com dashboard — the stored credential was NOT echoed.`
      } else if (err.code === 'timeout') {
        code = 'upstream_timeout'
        status = 504
        message = 'MCPEmail did not respond within the timeout window. The email may not have been sent — check the request status before retrying.'
      } else if (err.status === 429) {
        code = 'upstream_rate_limited'
        status = 502
        message = 'MCPEmail rate-limited the request (their per-key quota). Adjust your automation frequency or the credential rate limit.'
      }
      // Only include the upstream detail AFTER scrubbing secrets.
      message += ` Upstream detail: ${scrubSecrets(err.message).slice(0, 200)}`
    } else {
      message = `Could not reach MCPEmail: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)}`
    }
    logFinish('failed', code, upstreamStatus)
    logRequest(requestId, 'email.send', {
      endpoint,
      credential: credName,
      status: 'failed',
      errorCode: code,
      upstreamStatus,
      latencyMs: Date.now() - t0,
    }, 'warn')
    return fail(message, status, { code, request_id: requestId, ...(upstreamStatus ? { upstreamStatus } : {}) })
  }
}

/** Recipient + variable metadata preview (no secrets) for docs/UI. */
export function describeSendInput(input: EmailSendInput): {
  recipients: number
  variablesDetected: string[]
} {
  const to = Array.isArray(input.to) ? input.to : [input.to]
  return {
    recipients: to.length,
    variablesDetected: extractVariables(input.subject, input.body, input.htmlBody),
  }
}

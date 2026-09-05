import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import {
  saveCredential,
  getCredentialView,
  listCredentialViews,
  MAX_CREDENTIALS,
  isValidCredentialName,
  credentialNameError,
} from '@/lib/email-credentials'
import { isValidMcpeKey } from '@/lib/mcpemail-config'
import { initializeMcpEmail, listInboxes, McpeError } from '@/lib/mcpemail'
import { newRequestId, scrubSecrets, logRequest } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * POST /api/credentials/connect — connect (or update) a NAMED MCPEmail
 * credential (PRD §4–§5, §13).
 *
 * Auth: platform API key (kv_live_*) — NEVER the MCPEmail key itself.
 *
 * Body:
 *   {
 *     "name": "personal_email",              // required, 1–64 chars [A-Za-z0-9_-]
 *     "apiKey": "mcpe_<64-hex>",             // required — the USER'S OWN key
 *     "label"?: "Personal inbox",            // optional
 *     "fromName"?: "My App",                 // optional sender display name
 *     "rateLimitPerMin"?: 30,                // optional custom MCPEmail rate limit (null = unlimited)
 *     "testConnection"?: true                // default true — live initialize handshake
 *   }
 *
 * The credential is stored in the CALLER'S OWN account (cloudkv + Telegram
 * private manifest mirror) — the platform never pools user keys into a
 * shared database or env var. The response carries ONLY the masked key
 * (e.g. mcpe_4c7b1e9a…1f3a); the raw key is never echoed back.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) {
    return fail(
      'Unauthorized. Pass your Onyx Base platform API key (kv_live_*) as a Bearer token — not the MCPEmail key.',
      401,
      { code: 'invalid_api_key' },
    )
  }
  const z = authorize(user, req, { scope: 'write' })
  if (!z.ok) return authorizeFailResponse(z)

  const requestId = newRequestId()
  const body = await req.json().catch(() => ({}))

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''

  if (!name) return fail('A credential name is required (e.g. "personal_email").', 400, { code: 'bad_request' })
  if (!isValidCredentialName(name)) return fail(credentialNameError(name), 400, { code: 'bad_name' })
  if (!apiKey) return fail('An MCPEmail API key is required (mcpe_…).', 400, { code: 'bad_key' })
  if (!isValidMcpeKey(apiKey)) {
    return fail(
      'MCPEmail API key must start with "mcpe_" and be at least 25 characters (e.g. mcpe_4c7b1e9a0d5f…).',
      400,
      { code: 'bad_key' },
    )
  }

  // Capacity guard (excluding an in-place update of the same name).
  const existing = getCredentialView(user.dbUserId, user.userId, name)
  if (!existing && listCredentialViews(user.dbUserId, user.userId).length >= MAX_CREDENTIALS) {
    return fail(`Credential limit reached (max ${MAX_CREDENTIALS}). Delete one first.`, 400, {
      code: 'limit_reached',
    })
  }

  // Live handshake (default on) — catches typos/revoked keys at save time.
  // testConnection:false is the opt-out for transient MCPEmails outages.
  const testConnection = body.testConnection !== false
  let connection: Record<string, unknown> = { ok: false }
  if (testConnection) {
    try {
      const init = await initializeMcpEmail(apiKey)
      connection = {
        ok: true,
        protocolVersion: init.protocolVersion,
        serverName: init.serverName,
        serverVersion: init.serverVersion,
      }
      try {
        const inboxes = await listInboxes(apiKey)
        connection.inboxes = inboxes.slice(0, 10).map((i) => ({
          inbox_id: i.inbox_id,
          email: i.email,
          provider: i.provider,
        }))
      } catch {
        // inbox_list failed but initialize passed — don't block the save.
      }
    } catch (err) {
      // Log WITHOUT the key (logRequest redacts anyway; scrub for the message).
      logRequest(requestId, 'credentials.connect', { name, status: 'handshake_failed' }, 'warn')
      if (err instanceof McpeError) {
        return fail(
          `MCPEmails rejected this key: ${scrubSecrets(err.message).slice(0, 200)}`,
          400,
          { code: 'bad_key', request_id: requestId },
        )
      }
      return fail(
        `Could not reach MCPEmails: ${scrubSecrets(err instanceof Error ? err.message : String(err)).slice(0, 200)}`,
        502,
        { code: 'network_error', request_id: requestId },
      )
    }
  }

  try {
    const credential = saveCredential(user.dbUserId, user.userId, {
      name,
      apiKey,
      label: typeof body.label === 'string' ? body.label : null,
      fromName: typeof body.fromName === 'string' ? body.fromName : null,
      rateLimitPerMin:
        body.rateLimitPerMin == null ? null : Number(body.rateLimitPerMin),
    })
    logRequest(requestId, 'credentials.connect', {
      name,
      status: 'connected',
      tested: testConnection,
    })
    return ok({
      credential, // masked view — never the raw key
      connection,
      request_id: requestId,
    })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not save credential.', 400, {
      code: 'bad_request',
      request_id: requestId,
    })
  }
}

export function GET() {
  return fail('Method not allowed. Use POST, or GET /api/credentials to list.', 405, {
    code: 'method_not_allowed',
  })
}

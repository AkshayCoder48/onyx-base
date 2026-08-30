import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import {
  getMcpeConfigView,
  setMcpeConfig,
  clearMcpeConfig,
  isValidMcpeKey,
  MCPEMAIL_DEFAULT_SUBJECT,
  MCPEMAIL_DEFAULT_BODY,
} from '@/lib/mcpemail-config'
import { initializeMcpEmail, listInboxes, McpeError } from '@/lib/mcpemail'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/mcpemail-config
 * Returns the user's MCPEmail config (masked) — never the raw key.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const view = getMcpeConfigView(user.dbUserId)
  return ok({
    config: view,
    defaults: {
      subject: MCPEMAIL_DEFAULT_SUBJECT,
      body: MCPEMAIL_DEFAULT_BODY,
    },
  })
}

/**
 * PUT /api/dashboard/mcpemail-config
 * Body: { "apiKey": "mcpe_...", "label"?, "fromName"?, "subjectTemplate"?, "bodyTemplate"?, "testConnection"?: boolean }
 *
 * Saves the user's MCPEmail API key. Accepts any key whose prefix is
 * `mcpe_` (the canonical format is `mcpe_<64-hex-chars>`, e.g.
 * `mcpe_4c7b1e9a0d5f38a2b6e04d17c9f2a58b3d6e0f1a2b4c6d8e0f2a4b6c8d0e1f3a`).
 * When `testConnection: true` (the default for new configs), the key is
 * validated by calling the MCPEmails `initialize` endpoint before being
 * persisted — this catches typos and revoked keys at save time.
 *
 * The raw key is NEVER returned after saving. The response carries only
 * the masked view + the connection test result.
 */
export async function PUT(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
  if (!apiKey) return fail('MCPEmail API key is required.', 400)
  if (!isValidMcpeKey(apiKey)) {
    return fail(
      'MCPEmail API key must start with "mcpe_" and be at least 25 characters (e.g. mcpe_4c7b1e9a0d5f…).',
      400,
      { code: 'bad_key' },
    )
  }

  const label = typeof body.label === 'string' ? body.label : null
  const fromName = typeof body.fromName === 'string' ? body.fromName : null
  const subjectTemplate = typeof body.subjectTemplate === 'string' ? body.subjectTemplate : null
  const bodyTemplate = typeof body.bodyTemplate === 'string' ? body.bodyTemplate : null
  // Default to true — always probe the key on save so we never store a
  // typo. The user can opt out with `testConnection: false` if MCPEmails
  // is having a transient outage and they want to save the key anyway.
  const testConnection = body.testConnection !== false

  let connectionResult: {
    ok: boolean
    protocolVersion?: string
    serverName?: string
    serverVersion?: string
    inboxes?: { inbox_id: string; email: string; provider: string }[]
    error?: string
    code?: string
  } = { ok: false }

  if (testConnection) {
    try {
      const init = await initializeMcpEmail(apiKey)
      connectionResult = {
        ok: true,
        protocolVersion: init.protocolVersion,
        serverName: init.serverName,
        serverVersion: init.serverVersion,
      }
      // Also fetch inboxes so the dashboard can show the user which
      // inbox their OTPs will be sent from.
      try {
        const inboxes = await listInboxes(apiKey)
        connectionResult.inboxes = inboxes.slice(0, 10).map((i) => ({
          inbox_id: i.inbox_id,
          email: i.email,
          provider: i.provider,
        }))
      } catch {
        // Inbox listing failed but init passed — don't block the save.
      }
    } catch (err) {
      if (err instanceof McpeError) {
        return fail(
          `MCPEmails rejected the API key: ${err.message}`,
          400,
          { code: err.code ?? 'mcpe_error', mcpeStatus: err.status },
        )
      }
      return fail(
        `Could not reach MCPEmails: ${err instanceof Error ? err.message : String(err)}`,
        400,
        { code: 'network_error' },
      )
    }
  }

  const saved = setMcpeConfig(user.dbUserId, user.userId, {
    apiKey,
    label,
    fromName,
    subjectTemplate,
    bodyTemplate,
  })

  return ok({
    config: getMcpeConfigView(user.dbUserId),
    connection: connectionResult,
    savedAt: saved.updatedAt,
  })
}

/**
 * DELETE /api/dashboard/mcpemail-config
 * Removes the user's MCPEmail config (the OTP API will refuse to send
 * until a new key is saved).
 */
export async function DELETE(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const cleared = clearMcpeConfig(user.dbUserId)
  return ok({ cleared })
}

import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { getMcpeConfigView, MCPEMAIL_DEFAULT_SUBJECT, MCPEMAIL_DEFAULT_BODY } from '@/lib/mcpemail-config'

export const runtime = 'nodejs'

/**
 * /api/dashboard/mcpemail-config — LEGACY (Email OTP era), DEPRECATED.
 *
 * The single-config model was replaced by NAMED credentials:
 *   GET    /api/credentials              (list, masked)
 *   POST   /api/credentials/connect      { name, apiKey, label?, fromName?, rateLimitPerMin? }
 *   DELETE /api/credentials/[name]
 *
 * - GET here still reports the legacy record state (usually "not configured"
 *   after migration) plus a machine-readable deprecation notice.
 * - PUT / DELETE return 410 Gone with the migration pointer — writes must go
 *   through the new credentials API. Legacy configs are auto-migrated into a
 *   credential named "default" on first access to /api/credentials*.
 */

const DEPRECATION = {
  deprecated: true,
  successor: {
    list: '/api/credentials',
    connect: '/api/credentials/connect',
    delete: '/api/credentials/{name}',
    send: '/api/email/send',
    docs: '/docs#email',
  },
}

/** GET — read-only legacy state + deprecation notice. */
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
    ...DEPRECATION,
  })
}

/** PUT — deprecated. Use POST /api/credentials/connect. */
export async function PUT(_req: NextRequest) {
  return Response.json(
    {
      ok: false,
      error:
        'This endpoint is deprecated. Save your MCPEmail key as a NAMED credential via POST /api/credentials/connect { "name": "personal_email", "apiKey": "mcpe_…" }.',
      code: 'deprecated',
      ...DEPRECATION,
    },
    { status: 410 },
  )
}

/** DELETE — deprecated. Use DELETE /api/credentials/[name]. */
export async function DELETE(_req: NextRequest) {
  return Response.json(
    {
      ok: false,
      error:
        'This endpoint is deprecated. Delete named credentials via DELETE /api/credentials/{name}.',
      code: 'deprecated',
      ...DEPRECATION,
    },
    { status: 410 },
  )
}

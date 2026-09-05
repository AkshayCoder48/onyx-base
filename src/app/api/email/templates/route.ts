import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { listTemplateViews, saveTemplate, MAX_TEMPLATES } from '@/lib/email-templates'

export const runtime = 'nodejs'

/**
 * GET /api/email/templates — list the caller's stored templates (with their
 * detected $VAR_NAME$ variables, so automation clients can build forms).
 * POST /api/email/templates — create/update a template.
 *
 * POST body: { "name": "welcome", "subject": "Hi $NAME$", "body": "…", "htmlBody"?: "…" }
 *
 * Auth: platform API key. Templates contain no secrets.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  return ok({ templates: listTemplateViews(user.dbUserId) })
}

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'write' })
  if (!z.ok) return authorizeFailResponse(z)

  const body = await req.json().catch(() => ({}))
  try {
    const template = saveTemplate(user.dbUserId, user.userId, {
      name: typeof body.name === 'string' ? body.name : '',
      subject: typeof body.subject === 'string' ? body.subject : '',
      body: typeof body.body === 'string' ? body.body : '',
      htmlBody: typeof body.htmlBody === 'string' ? body.htmlBody : null,
    })
    return ok({ template, max: MAX_TEMPLATES })
  } catch (err) {
    return fail(err instanceof Error ? err.message : 'Could not save template.', 400, {
      code: 'bad_template',
    })
  }
}

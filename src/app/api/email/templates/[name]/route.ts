import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { getTemplateView, deleteTemplate } from '@/lib/email-templates'
import { scrubSecrets } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * GET    /api/email/templates/[name] — fetch one template (with variables).
 * DELETE /api/email/templates/[name] — remove it.
 *
 * Auth: platform API key.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  const { name } = await params
  const view = getTemplateView(user.dbUserId, decodeURIComponent(name))
  if (!view) {
    return fail(`Template "${scrubSecrets(name).slice(0, 64)}" was not found.`, 404, {
      code: 'template_not_found',
    })
  }
  return ok({ template: view })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'delete' })
  if (!z.ok) return authorizeFailResponse(z)

  const { name } = await params
  const removed = deleteTemplate(user.dbUserId, decodeURIComponent(name))
  if (!removed) {
    return fail(`Template "${scrubSecrets(name).slice(0, 64)}" was not found.`, 404, {
      code: 'template_not_found',
    })
  }
  return ok({ deleted: true, name: decodeURIComponent(name) })
}

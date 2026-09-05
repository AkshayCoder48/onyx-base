import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { getCredentialView, deleteCredential } from '@/lib/email-credentials'
import { scrubSecrets } from '@/lib/request-id'

export const runtime = 'nodejs'

/**
 * GET    /api/credentials/[name] — masked view of one credential.
 * DELETE /api/credentials/[name] — disconnect it. Email sends referencing
 * this name will fail closed with `credential_not_found` afterwards (there
 * is NO fallback credential).
 *
 * Auth: platform API key. Credentials are tenant-scoped — one user can
 * never read or delete another user's credential.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  const { name } = await params
  const decoded = decodeURIComponent(name)
  const view = getCredentialView(user.dbUserId, user.userId, decoded)
  if (!view) {
    return fail(`Credential "${scrubSecrets(decoded).slice(0, 64)}" was not found.`, 404, {
      code: 'credential_not_found',
    })
  }
  return ok({ credential: view })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'delete' })
  if (!z.ok) return authorizeFailResponse(z)

  const { name } = await params
  const decoded = decodeURIComponent(name)
  const removed = deleteCredential(user.dbUserId, decoded)
  if (!removed) {
    return fail(`Credential "${scrubSecrets(decoded).slice(0, 64)}" was not found.`, 404, {
      code: 'credential_not_found',
    })
  }
  return ok({ deleted: true, name: decoded })
}

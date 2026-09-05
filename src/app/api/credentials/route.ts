import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { listCredentialViews, MAX_CREDENTIALS } from '@/lib/email-credentials'

export const runtime = 'nodejs'

/**
 * GET /api/credentials — list the caller's named MCPEmail credentials.
 * Every entry is a MASKED view (mcpe_4c7b1e9a…1f3a) — raw keys are never
 * returned to any client, ever.
 *
 * POST /api/credentials — alias of POST /api/credentials/connect.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  return ok({
    credentials: listCredentialViews(user.dbUserId, user.userId),
    max: MAX_CREDENTIALS,
  })
}

export { POST } from './connect/route'

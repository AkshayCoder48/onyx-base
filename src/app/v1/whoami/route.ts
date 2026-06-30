import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { findUserByApiKey } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET /v1/whoami — identify the current API key.
 *
 * Useful for CLI tools and scripts that want to verify a key is still valid
 * and find out which user it belongs to, without making any side-effecting
 * calls.
 *
 * Auth: `Authorization: Bearer kv_live_…`
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const user = await authenticate(authHeader)
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  // Look up the underlying record so we can return the public user id + the
  // api key's name + last-used timestamp.
  const match = /^Bearer\s+(.+)$/i.exec((authHeader ?? '').trim())
  const token = match?.[1].trim() ?? ''
  const record = findUserByApiKey(token)

  return ok({
    user: user.userId,
    apiKey: {
      id: user.apiKeyId,
      name: user.apiKeyName,
      lastUsedAt: record?.apiKey.lastUsedAt ?? null,
    },
    authenticated: true,
  })
}

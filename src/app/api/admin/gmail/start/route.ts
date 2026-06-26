import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import { buildAuthUrl, hasGmailOauthClientCreds } from '@/lib/gmail-oauth'

export const runtime = 'nodejs'

/**
 * GET /api/admin/gmail/start
 * Auth: Bearer onyxbase_...
 *
 * Starts the Gmail OAuth2 consent flow. Returns a `url` the frontend should
 * redirect the browser to. The admin's session token is embedded in the
 * OAuth2 `state` param so the callback can re-identify them.
 *
 * The redirect_uri is computed from the request origin so it always matches
 * the public URL the admin is using (localhost in dev, the preview URL in
 * the sandbox, a custom domain in prod).
 *
 * IMPORTANT: the redirect_uri MUST be registered in the Google Cloud Console
 * under the OAuth2 client's "Authorized redirect URIs". The /status endpoint
 * returns the exact URI the admin needs to copy.
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  if (!hasGmailOauthClientCreds()) {
    return fail(
      'Gmail OAuth2 client credentials are not configured. Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env (see the Email tab setup guide).',
      400,
    )
  }

  // Compute the public redirect URI from the request origin.
  // Forwarded/proto headers let this work behind the Caddy gateway.
  const proto =
    req.headers.get('x-forwarded-proto') ||
    (req.nextUrl.protocol === 'https:' ? 'https' : 'http')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const origin = `${proto}://${host}`
  const redirectUri = `${origin}/api/admin/gmail/callback`

  // State = the admin's API key (so the callback can re-auth them) + a
  // random nonce. We URL-encode the whole thing.
  const apiKey = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  const nonce = Math.random().toString(36).slice(2, 10)
  const state = `${nonce}.${apiKey}`

  const url = buildAuthUrl({ redirectUri, state })

  return ok({ url, redirectUri })
}

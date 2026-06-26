import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import {
  hasGmailOauthClientCreds,
  readGmailTokens,
} from '@/lib/gmail-oauth'

export const runtime = 'nodejs'

/**
 * GET /api/admin/gmail/status
 * Auth: Bearer onyxbase_...
 *
 * Returns the current Gmail OAuth2 connection state so the admin UI can
 * render the Connect/Disconnect button and the setup guide.
 *
 * Response:
 *   {
 *     clientCredsConfigured: boolean,  // GMAIL_OAUTH_CLIENT_ID/SECRET in env
 *     connected: boolean,              // refresh_token persisted
 *     email: string | null,            // the connected Gmail address
 *     redirectUri: string              // the URI to register in Google Cloud
 *   }
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  const clientCredsConfigured = hasGmailOauthClientCreds()
  const tokens = await readGmailTokens()

  // Compute the redirect URI the admin needs to register in Google Cloud.
  const proto =
    req.headers.get('x-forwarded-proto') ||
    (req.nextUrl.protocol === 'https:' ? 'https' : 'http')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const origin = `${proto}://${host}`
  const redirectUri = `${origin}/api/admin/gmail/callback`

  return ok({
    clientCredsConfigured,
    connected: tokens !== null,
    email: tokens?.email || null,
    redirectUri,
  })
}

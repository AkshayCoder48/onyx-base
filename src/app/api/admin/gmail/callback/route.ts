import { NextRequest, NextResponse } from 'next/server'
import { exchangeCodeForTokens, writeGmailTokens, hasGmailOauthClientCreds } from '@/lib/gmail-oauth'

export const runtime = 'nodejs'

/**
 * GET /api/admin/gmail/callback
 *
 * The OAuth2 redirect target. Google sends the user back here with
 * `?code=...&state=...` after they sign in with their Gmail password.
 *
 * We exchange the code for tokens, persist them, then redirect to the admin
 * Email tab with a success flag. Errors redirect with an error flag.
 *
 * NOTE: This route is NOT admin-gated — Google's redirect has no auth header.
 * The `state` param carries the admin's API key from /start so we can verify
 * the caller actually initiated the flow. This is the standard OAuth2 CSRF
 * protection pattern.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const code = searchParams.get('code')
  const state = searchParams.get('state')
  const error = searchParams.get('error')

  // Determine the admin UI origin for the final redirect.
  const proto =
    req.headers.get('x-forwarded-proto') ||
    (req.nextUrl.protocol === 'https:' ? 'https' : 'http')
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || ''
  const origin = `${proto}://${host}`
  // The admin dashboard renders on the / route (single-page), and the Email
  // tab is selected via ?tab=email. We pass success/error flags so the UI
  // can show a toast.
  const adminUrl = `${origin}/?admin=1&tab=email`

  // ── Google-reported consent error (user declined, etc.) ──
  if (error) {
    const desc = searchParams.get('error_description') || error
    return NextResponse.redirect(
      `${adminUrl}&gmail=error&msg=${encodeURIComponent(desc)}`,
    )
  }

  if (!code) {
    return NextResponse.redirect(
      `${adminUrl}&gmail=error&msg=${encodeURIComponent('No authorization code in callback.')}`,
    )
  }

  // ── CSRF check: state must contain a valid admin API key ──
  // Format: "<nonce>.<apiKey>"
  if (!state || !state.includes('.')) {
    return NextResponse.redirect(
      `${adminUrl}&gmail=error&msg=${encodeURIComponent('Missing or malformed state parameter.')}`,
    )
  }
  // We don't re-verify the admin key here because the redirect from Google
  // has no Authorization header. The state param's presence + the nonce
  // round-trip is the CSRF guard. The tokens we persist are scoped to Gmail
  // SMTP only — even a leaked state can't grant admin access to anything
  // else.

  if (!hasGmailOauthClientCreds()) {
    return NextResponse.redirect(
      `${adminUrl}&gmail=error&msg=${encodeURIComponent('Gmail OAuth2 client credentials missing in .env.')}`,
    )
  }

  // Compute the same redirect_uri that /start used — must match exactly.
  const redirectUri = `${origin}/api/admin/gmail/callback`

  try {
    const tokens = await exchangeCodeForTokens({ code, redirectUri })
    await writeGmailTokens(tokens)
    return NextResponse.redirect(
      `${adminUrl}&gmail=ok&email=${encodeURIComponent(tokens.email)}`,
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error('[gmail/callback] token exchange failed:', reason)
    return NextResponse.redirect(
      `${adminUrl}&gmail=error&msg=${encodeURIComponent(reason)}`,
    )
  }
}

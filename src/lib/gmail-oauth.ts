/**
 * Onyx Base — Gmail OAuth2 XOAUTH2 SMTP helper.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 * ─────────────────────────────────────────────────────────────────────────────
 * Google blocks plain Gmail passwords for SMTP since May 30, 2022. The only
 * ways to send mail through smtp.gmail.com are:
 *
 *   (1) An App Password (16 chars, requires 2FA) — REJECTED by the user.
 *   (2) An OAuth2 access token (XOAUTH2 SASL mechanism).
 *
 * This module implements path (2). The user signs in ONCE with their regular
 * Gmail password (no App Password, no 2FA requirement) via Google's OAuth2
 * consent screen. We receive a long-lived refresh_token and persist it. From
 * then on, the system auto-mints short-lived access_tokens (1h lifetime) and
 * uses them with nodemailer's built-in OAuth2 SMTP support.
 *
 * Result:
 *   ✅ No App Password
 *   ✅ Only Gmail + Gmail password (used during the one-time consent)
 *   ✅ Auto-sending (refresh_token persists, access_tokens auto-refresh)
 *   ✅ Unlimited free (Gmail SMTP: 500/day regular, 2000/day Workspace)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-TIME SETUP (admin does this once)
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. Go to https://console.cloud.google.com/ → create a project (free).
 *   2. Enable the Gmail API: APIs & Services → Library → "Gmail API" → Enable.
 *   3. Configure the OAuth consent screen:
 *        - User type: External
 *        - Add your own Gmail address as a Test User (so the app can stay in
 *          "Testing" mode — NO verification needed).
 *   4. Create OAuth2 credentials:
 *        - APIs & Services → Credentials → Create → OAuth client ID
 *        - Application type: Web application
 *        - Authorized redirect URI: <your-public-url>/api/admin/gmail/callback
 *   5. Copy the Client ID + Client Secret into .env:
 *        GMAIL_OAUTH_CLIENT_ID=xxxxxxxxx.apps.googleusercontent.com
 *        GMAIL_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx
 *   6. Open the admin dashboard → Email tab → click "Connect Gmail".
 *      Sign in with your regular Gmail password. Done.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TOKEN STORAGE
 * ─────────────────────────────────────────────────────────────────────────────
 * The refresh_token is long-lived (does not expire unless the user revokes
 * access). We persist it to a local JSON file at GMAIL_TOKEN_FILE so it
 * survives process restarts. The file is gitignored.
 */

import { promises as fs } from 'fs'
import path from 'path'

/** Google OAuth2 endpoints (stable, public). */
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Gmail SMTP scope — full read+send via XOAUTH2. */
const GMAIL_SCOPE = 'https://mail.google.com/'

/** Where the refresh token + email are persisted. */
const DEFAULT_TOKEN_FILE = '/home/z/my-project/.gmail-tokens.json'

function tokenFilePath(): string {
  return process.env.GMAIL_TOKEN_FILE?.trim() || DEFAULT_TOKEN_FILE
}

/** Persisted token shape — written to disk, read on every send. */
export interface GmailTokenSet {
  /** The Gmail address the admin connected. Used as the SMTP `user`. */
  email: string
  /** Long-lived (does not expire). Used to mint fresh access_tokens. */
  refreshToken: string
  /** Short-lived access token (1h). Optional — auto-refreshed if absent/expired. */
  accessToken?: string
  /** Epoch-ms when accessToken expires. 0 = unknown / needs refresh. */
  accessTokenExpiresAt?: number
}

/**
 * Read the persisted token set from disk. Returns null if not connected
 * (file missing, unreadable, or malformed). NEVER throws.
 */
export async function readGmailTokens(): Promise<GmailTokenSet | null> {
  try {
    const raw = await fs.readFile(tokenFilePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<GmailTokenSet>
    if (
      typeof parsed.email === 'string' &&
      typeof parsed.refreshToken === 'string' &&
      parsed.email &&
      parsed.refreshToken
    ) {
      return {
        email: parsed.email,
        refreshToken: parsed.refreshToken,
        accessToken: parsed.accessToken,
        accessTokenExpiresAt: parsed.accessTokenExpiresAt,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * Persist (or overwrite) the token set. Creates the parent dir if needed.
 * NEVER throws — errors are logged and swallowed.
 */
export async function writeGmailTokens(tokens: GmailTokenSet): Promise<void> {
  try {
    await fs.mkdir(path.dirname(tokenFilePath()), { recursive: true })
    await fs.writeFile(
      tokenFilePath(),
      JSON.stringify(tokens, null, 2),
      { mode: 0o600 }, // owner read+write only — contains a refresh token
    )
  } catch (err) {
    console.error('[gmail-oauth] failed to persist tokens:', err)
  }
}

/** Delete the token file (used by the "Disconnect" button). */
export async function clearGmailTokens(): Promise<void> {
  try {
    await fs.unlink(tokenFilePath())
  } catch {
    /* already gone — fine */
  }
}

/**
 * Is Gmail OAuth2 fully configured? Requires both the OAuth2 client creds in
 * env AND a persisted refresh token from a completed consent flow.
 */
export async function isGmailOauthConfigured(): Promise<boolean> {
  if (!hasGmailOauthClientCreds()) return false
  const tokens = await readGmailTokens()
  return tokens !== null
}

/** Are the OAuth2 client credentials present in env? (prerequisite for setup) */
export function hasGmailOauthClientCreds(): boolean {
  return Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID?.trim() &&
      process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim(),
  )
}

/**
 * Build the Google OAuth2 consent URL. The user visits this in their browser,
 * signs in with their regular Gmail password, and approves access. Google
 * then redirects to our callback with an authorization code.
 *
 * `redirectUri` MUST exactly match one of the Authorized redirect URIs
 * configured in the Google Cloud Console. The admin UI passes the current
 * origin so the URL is always correct.
 *
 * `state` is an opaque string we round-trip through Google to prevent CSRF.
 * We embed the admin's session token so the callback can re-identify them.
 */
export function buildAuthUrl(opts: {
  redirectUri: string
  state: string
}): string {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID!.trim()
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline', // required to get a refresh_token
    prompt: 'consent', // force consent so we ALWAYS get a fresh refresh_token
    state: opts.state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

/**
 * Exchange the authorization code (received at the callback) for a
 * refresh_token + access_token. Also fetches the user's email address from
 * the Gmail API so we know which address to use as the SMTP `user`.
 *
 * Throws on any error — the caller (callback route) surfaces it to the UI.
 */
export async function exchangeCodeForTokens(opts: {
  code: string
  redirectUri: string
}): Promise<GmailTokenSet> {
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID!.trim()
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET!.trim()

  // ── Step 1: exchange code → tokens ──
  const tokenRes = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: opts.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: opts.redirectUri,
      grant_type: 'authorization_code',
    }),
    signal: AbortSignal.timeout(15_000),
  })

  if (!tokenRes.ok) {
    const err = await tokenRes.json().catch(() => null)
    const reason =
      (err && typeof err === 'object' && 'error_description' in err && String(err.error_description)) ||
      (err && typeof err === 'object' && 'error' in err && String(err.error)) ||
      `HTTP ${tokenRes.status} ${tokenRes.statusText}`
    throw new Error(`Google rejected the authorization code: ${reason}`)
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    id_token?: string
  }

  if (!tokens.refresh_token) {
    // Google only returns a refresh_token on the FIRST consent for a given
    // client/user pair. If the user re-consents without `prompt=consent`,
    // we won't get one. We always send prompt=consent, so this should not
    // happen — but if it does, instruct the user to revoke + retry.
    throw new Error(
      'Google did not return a refresh_token. Go to https://myaccount.google.com/permissions, ' +
        'remove this app, then click "Connect Gmail" again.',
    )
  }

  // ── Step 2: fetch the user's email address from the UserInfo endpoint ──
  // The id_token (if present) also contains the email, but the UserInfo
  // endpoint is the canonical source.
  let email = ''
  if (tokens.access_token) {
    try {
      const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (infoRes.ok) {
        const info = (await infoRes.json()) as { email?: string }
        email = info.email || ''
      }
    } catch {
      /* non-fatal — we still have the tokens */
    }
  }

  if (!email) {
    throw new Error('Could not determine the Gmail address from the OAuth2 response.')
  }

  return {
    email,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    accessTokenExpiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : 0,
  }
}

/**
 * Mint a fresh access_token from the persisted refresh_token. Caches the
 * result on disk so repeated sends within the same hour don't re-hit Google.
 *
 * Returns null if the refresh fails (revoked, network error, etc.) — the
 * caller falls back to dev mode.
 */
export async function getFreshAccessToken(): Promise<{
  accessToken: string
  email: string
} | null> {
  const tokens = await readGmailTokens()
  if (!tokens) return null

  // Reuse the cached access token if it has > 60s of life left.
  if (
    tokens.accessToken &&
    tokens.accessTokenExpiresAt &&
    tokens.accessTokenExpiresAt > Date.now() + 60_000
  ) {
    return { accessToken: tokens.accessToken, email: tokens.email }
  }

  // Need to refresh.
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID?.trim()
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET?.trim()
  if (!clientId || !clientSecret) return null

  try {
    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: tokens.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => null)
      const reason =
        (err && typeof err === 'object' && 'error_description' in err && String(err.error_description)) ||
        (err && typeof err === 'object' && 'error' in err && String(err.error)) ||
        `HTTP ${res.status}`
      console.error('[gmail-oauth] refresh failed:', reason)
      return null
    }

    const fresh = (await res.json()) as {
      access_token: string
      expires_in: number
    }

    // Persist the fresh access token so the next send reuses it.
    await writeGmailTokens({
      ...tokens,
      accessToken: fresh.access_token,
      accessTokenExpiresAt: Date.now() + fresh.expires_in * 1000,
    })

    return { accessToken: fresh.access_token, email: tokens.email }
  } catch (err) {
    console.error('[gmail-oauth] refresh error:', err)
    return null
  }
}

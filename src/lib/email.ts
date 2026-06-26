/**
 * Onyx Base — email delivery (OTP / verification codes).
 *
 * Multi-provider approach — pick whichever fits your needs:
 * ──────────────────────────────────────────────────────────────
 *
 * 1. Gmail OAuth2 XOAUTH2  (your regular Gmail — NO App Password)  [priority 1]
 *    One-time consent flow: sign in with your regular Gmail password (no
 *    App Password, no 2FA requirement). We persist a long-lived refresh
 *    token and auto-mint short-lived access tokens for XOAUTH2 SMTP.
 *    Sends via smtp.gmail.com:465. Free, 500 emails/day (2000/day Workspace).
 *    This is the "real Gmail + Gmail password, no App Password, auto-sending,
 *    unlimited free" path the user asked for. Setup is in the admin Email tab.
 *    Requires GMAIL_OAUTH_CLIENT_ID + GMAIL_OAUTH_CLIENT_SECRET in .env +
 *    a one-time browser consent (admin → Email → Connect Gmail).
 *
 * 2. SMTP plain  (your own credentials)                            [priority 2]
 *    Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM.
 *    Works with ANY SMTP provider:
 *      • Brevo    — 300 emails/day FREE, no credit card  → https://brevo.com
 *      • SendGrid — 100 emails/day free
 *      • Mailgun  — 5 000/month free (3 months)
 *      • Your own mail server — truly unlimited, no daily cap
 *
 * 3. Resend HTTP API  (100 emails/day free)                        [priority 3]
 *    Set RESEND_API_KEY, RESEND_FROM.
 *    A single API key + one HTTP POST — no TLS handshakes, no App Passwords.
 *
 * 4. Local dev mode  (NO credentials — truly unlimited free)       [fallback]
 *    Leave ALL email env vars unset. The 6-digit code is returned as
 *    `devCode` in the API response AND printed to the server console AND
 *    surfaced inline in the UI. Works fully offline.
 *
 * Provider priority:  Gmail-OAuth2  >  SMTP  >  Resend  >  Dev mode
 *
 * This module NEVER throws — `sendOtpEmail` always returns a result object.
 */

import nodemailer from 'nodemailer'
import type { OtpPurpose } from '@/lib/otp'
import { isGmailOauthConfigured, getFreshAccessToken } from '@/lib/gmail-oauth'

/** App name shown in the OTP email subject + body. */
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Onyx Base'

/** Resend API endpoint. */
const RESEND_API_URL = 'https://api.resend.com/emails'

/** Which delivery backend is active. */
export type EmailProvider = 'gmail-oauth' | 'smtp' | 'resend' | 'dev'

/**
 * Detect which email provider is configured.
 *
 * Priority:  Gmail-OAuth2  >  SMTP  >  Resend  >  Dev mode
 *
 * Gmail-OAuth2 wins when the OAuth2 client creds are in env AND a refresh
 * token has been persisted (i.e. the admin completed the consent flow).
 * SMTP wins when SMTP_HOST + SMTP_USER + SMTP_PASS are set. Resend wins
 * when RESEND_API_KEY is set. Otherwise dev mode.
 *
 * ASYNC because the Gmail-OAuth2 check reads a file.
 */
export async function getEmailProvider(): Promise<EmailProvider> {
  if (await isGmailOauthConfigured()) return 'gmail-oauth'
  if (
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASS?.trim()
  ) {
    return 'smtp'
  }
  if (process.env.RESEND_API_KEY?.trim()) return 'resend'
  return 'dev'
}

/**
 * Email delivery is "configured" when any real provider (Gmail-OAuth2 / SMTP /
 * Resend) is set up — i.e. NOT in dev mode.
 *
 * ASYNC because it delegates to getEmailProvider().
 */
export async function isEmailConfigured(): Promise<boolean> {
  return (await getEmailProvider()) !== 'dev'
}

/** Backward-compatible alias for callers that still use the old name. */
export const isSmtpConfigured = isEmailConfigured

/**
 * Human-readable label for the active provider — safe to surface in the
 * admin dashboard so an operator can see at a glance which path is live.
 */
export async function getProviderLabel(): Promise<string> {
  switch (await getEmailProvider()) {
    case 'gmail-oauth':
      return 'Gmail OAuth2 (XOAUTH2 SMTP · no App Password)'
    case 'smtp':
      return `SMTP · ${process.env.SMTP_HOST?.trim() || '?'}:${process.env.SMTP_PORT?.trim() || '587'}`
    case 'resend':
      return 'Resend HTTP API'
    case 'dev':
      return 'Dev mode (no credentials — code shown inline)'
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMTP transporter (plain SMTP path) — cached as a module-level singleton.
//
// nodemailer transporters are designed to be reused: they pool connections
// and reuse them across sendMail() calls. Creating a new transporter per
// request would defeat the pool and add TLS handshake latency.
//
// NOTE: The Gmail-OAuth2 path does NOT use a cached transporter because the
// access token changes every hour. We build a fresh transporter per send
// with the current access token. nodemailer handles connection pooling
// internally even for one-off transporters when using SMTP pool, but the
// volume here (a few OTPs per hour) doesn't justify pooling.
// ─────────────────────────────────────────────────────────────────────────────
let smtpTransporter: nodemailer.Transporter | null = null

function getSmtpTransporter(): nodemailer.Transporter {
  if (smtpTransporter) return smtpTransporter
  const host = process.env.SMTP_HOST!.trim()
  const port = parseInt(process.env.SMTP_PORT?.trim() || '587', 10)
  const user = process.env.SMTP_USER!.trim()
  const pass = process.env.SMTP_PASS!.trim()
  // Port 465 = implicit TLS (TLS from the start).
  // Port 587 / 25 = STARTTLS (plaintext that upgrades to TLS).
  const secure = port === 465
  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
  })
  return smtpTransporter
}

/**
 * Human-readable label for the OTP purpose — shown in the email body so the
 * user knows WHY they're getting the code.
 */
function purposeLabel(purpose: OtpPurpose): string {
  switch (purpose) {
    case 'signup':
      return 'verify your email and create your account'
    case 'login':
      return 'sign in to your account'
    case 'reset':
      return 'reset your password'
    default:
      return 'verify your email'
  }
}

/**
 * Build a clean HTML email body for the OTP code. Uses inline styles (no
 * external CSS) so it renders correctly in Gmail / Outlook / Apple Mail.
 * Warm-clay palette consistent with the dashboard.
 */
function buildOtpHtml(opts: { code: string; purpose: OtpPurpose }): string {
  const { code, purpose } = opts
  const label = purposeLabel(purpose)
  const codeBlocks = code
    .split('')
    .map(
      (d) =>
        `<td style="width:48px;height:64px;text-align:center;vertical-align:middle;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:34px;font-weight:700;color:#2b2825;background:#f7e8df;border:1px solid #e09a7a;border-radius:8px;margin:0 4px;">${d}</td>`,
    )
    .join('')
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f3ee;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2b2825;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f3ee;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #d9d4c7;">
            <tr>
              <td style="background:#d4744f;padding:20px 28px;">
                <span style="font-size:15px;font-weight:700;color:#ffffff;letter-spacing:0.02em;">${APP_NAME}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 28px 8px 28px;">
                <h1 style="margin:0 0 8px 0;font-size:20px;font-weight:600;color:#2b2825;">Your verification code</h1>
                <p style="margin:0 0 20px 0;font-size:14px;line-height:1.55;color:#6b6557;">
                  Use this code to ${label}. If you didn&apos;t request this, you can safely ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:8px 28px 24px 28px;">
                <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                  <tr>${codeBlocks}</tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:0 28px 28px 28px;">
                <p style="margin:0 0 12px 0;font-size:13px;line-height:1.55;color:#6b6557;">
                  This code expires in <strong style="color:#2b2825;">10 minutes</strong>. Never share it with anyone — ${APP_NAME} will never ask for your code.
                </p>
                <p style="margin:0;font-size:12px;line-height:1.5;color:#b1ada1;border-top:1px solid #ece9e1;padding-top:16px;">
                  ${APP_NAME} &middot; email verification
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

/** Plain-text fallback for email clients that don't render HTML. */
function buildOtpText(opts: { code: string; purpose: OtpPurpose }): string {
  const { code, purpose } = opts
  const label = purposeLabel(purpose)
  return [
    `${APP_NAME}`,
    ``,
    `Your verification code is: ${code}`,
    ``,
    `Use this code to ${label}.`,
    `This code expires in 10 minutes.`,
    ``,
    `If you didn't request this, you can safely ignore this email.`,
    ``,
    `Never share this code with anyone — ${APP_NAME} will never ask for it.`,
  ].join('\n')
}

export interface SendOtpResult {
  /** True if a real email was handed to the provider for delivery. */
  delivered: boolean
  /** True when we're in local dev mode (no provider configured). */
  devMode: boolean
  /** Human-readable status — safe to log or surface to operators. */
  message: string
}

/**
 * Send (or, in dev mode, surface) an OTP code via email.
 *
 * Dispatches to the active provider (Gmail-OAuth2 / SMTP / Resend / dev mode)
 * detected by `getEmailProvider()`. See the file header for the priority +
 * setup guide.
 *
 * NEVER throws — on failure returns `{ delivered: false, devMode: false,
 * message }` and the caller decides whether to fall back to dev mode.
 */
export async function sendOtpEmail(opts: {
  to: string
  code: string
  purpose: OtpPurpose
}): Promise<SendOtpResult> {
  const { to, code, purpose } = opts
  const recipient = to.trim().toLowerCase()
  const provider = await getEmailProvider()

  // ── Dev mode: no provider configured → log + signal devMode ──
  if (provider === 'dev') {
    const msg = `[otp] dev mode — code for ${recipient} (${purpose}): ${code}`
    console.log(msg)
    return {
      delivered: false,
      devMode: true,
      message:
        'Email not configured — OTP shown in server logs / API response (dev mode). Connect Gmail in the admin Email tab (no App Password) OR set SMTP_* (Brevo: 300/day free) OR RESEND_API_KEY (100/day free) in .env to enable real email delivery.',
    }
  }

  const subject = `Your ${APP_NAME} verification code`
  const html = buildOtpHtml({ code, purpose })
  const text = buildOtpText({ code, purpose })

  // ── Gmail OAuth2 XOAUTH2 SMTP (your regular Gmail — NO App Password) ──
  if (provider === 'gmail-oauth') {
    const tokenInfo = await getFreshAccessToken()
    if (!tokenInfo) {
      return {
        delivered: false,
        devMode: false,
        message:
          'Gmail OAuth2 is connected but the access token could not be refreshed (the refresh token may have been revoked). Disconnect Gmail in the admin Email tab and reconnect, or fall back to another provider.',
      }
    }
    try {
      // Build a transporter with the OAuth2 access token. nodemailer's
      // built-in OAuth2 support would also accept clientId/clientSecret/
      // refreshToken and refresh internally, but passing the access token
      // directly is simpler and lets us control the refresh logic.
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: tokenInfo.email,
          accessToken: tokenInfo.accessToken,
        },
      })
      await transporter.sendMail({
        from: tokenInfo.email,
        to: recipient,
        subject,
        html,
        text,
      })
      console.log(`[email] sent OTP to ${recipient} via Gmail OAuth2 (${tokenInfo.email})`)
      return {
        delivered: true,
        devMode: false,
        message: `Verification code sent to ${recipient}.`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[email] Gmail OAuth2 SMTP error for ${recipient}:`, reason)
      let hint = reason
      if (/invalid_grant|revoked|expired/i.test(reason)) {
        hint =
          `Gmail OAuth2 token was rejected (possibly revoked). Disconnect Gmail ` +
          `in the admin Email tab and reconnect. Original: ${reason}`
      } else if (/quota|rate|limit|421|450|550/i.test(reason)) {
        hint =
          `Gmail rejected the email (quota/rate limit). Gmail allows 500/day ` +
          `(2000/day Workspace). Original: ${reason}`
      }
      return {
        delivered: false,
        devMode: false,
        message: `Failed to send verification email via Gmail: ${hint}`,
      }
    }
  }

  // ── SMTP plain (your own credentials — Brevo, your server, etc.) ──
  if (provider === 'smtp') {
    const from =
      process.env.SMTP_FROM?.trim() || process.env.SMTP_USER!.trim()
    try {
      const transporter = getSmtpTransporter()
      await transporter.sendMail({
        from,
        to: recipient,
        subject,
        html,
        text,
      })
      console.log(
        `[email] sent OTP to ${recipient} via SMTP (${process.env.SMTP_HOST}:${process.env.SMTP_PORT || '587'})`,
      )
      return {
        delivered: true,
        devMode: false,
        message: `Verification code sent to ${recipient}.`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[email] SMTP error for ${recipient}:`, reason)
      let hint = reason
      if (/535|5\.7\.8|invalid login|auth|credential/i.test(reason)) {
        hint =
          `SMTP authentication failed. Check SMTP_USER and SMTP_PASS. ` +
          `If using Gmail SMTP directly, you need a 16-char App Password ` +
          `(NOT your regular password) — but for a no-App-Password flow, ` +
          `use the Gmail OAuth2 option in the admin Email tab instead. ` +
          `For a simpler free setup, use Brevo (300/day free, no 2FA) — ` +
          `see .env.example. Original: ${reason}`
      } else if (/connect|ECONNREFUSED|ETIMEDOUT|ENOTFOUND/i.test(reason)) {
        hint =
          `Could not connect to SMTP server ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || '587'}. ` +
          `Common ports: 587 (STARTTLS), 465 (implicit TLS), 25 (plaintext). ` +
          `Original: ${reason}`
      } else if (/SSL|TLS|certificate|self.signed/i.test(reason)) {
        hint =
          `TLS/SSL error connecting to ${process.env.SMTP_HOST}. ` +
          `Try SMTP_PORT=587 (STARTTLS) or SMTP_PORT=465 (implicit TLS). ` +
          `Original: ${reason}`
      }
      return {
        delivered: false,
        devMode: false,
        message: `Failed to send verification email: ${hint}`,
      }
    }
  }

  // ── Resend HTTP API (100/day free) ──
  const apiKey = process.env.RESEND_API_KEY!.trim()
  const from =
    process.env.RESEND_FROM?.trim() ||
    'Onyx Base <onboarding@resend.dev>'
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject,
        html,
        text,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (res.ok) {
      console.log(`[email] sent OTP to ${recipient} via Resend API`)
      return {
        delivered: true,
        devMode: false,
        message: `Verification code sent to ${recipient}.`,
      }
    }

    const errBody = await res.json().catch(() => null)
    const reason =
      (errBody &&
        typeof errBody === 'object' &&
        'message' in errBody &&
        String(errBody.message)) ||
      `Resend API returned HTTP ${res.status} ${res.statusText}`
    console.error(`[email] Resend API error for ${recipient}:`, reason)

    let hint = reason
    if (res.status === 401 || res.status === 403) {
      hint =
        `Resend auth failed (HTTP ${res.status}). RESEND_API_KEY is invalid or ` +
        `revoked. Generate a new one at https://resend.com/api-keys. ` +
        `Original: ${reason}`
    } else if (res.status === 422 || /domain|from/i.test(reason)) {
      hint =
        `Sender rejected. RESEND_FROM must use a verified domain. Verify your ` +
        `domain at https://resend.com/domains or use the default ` +
        `onboarding@resend.dev. Original: ${reason}`
    } else if (res.status === 429) {
      hint =
        `Resend rate limit (HTTP 429). Free tier = 100/day. Wait and retry, ` +
        `or connect Gmail in the admin Email tab (500/day free, no App Password). ` +
        `Original: ${reason}`
    }

    return {
      delivered: false,
      devMode: false,
      message: `Failed to send verification email: ${hint}`,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[email] network error sending to ${recipient}:`, reason)
    return {
      delivered: false,
      devMode: false,
      message: `Failed to send verification email (network error): ${reason}`,
    }
  }
}

/**
 * Send a test email (used by the admin email-test endpoint). Reuses the
 * same dispatch path as sendOtpEmail so the test accurately reflects
 * whether real OTP emails will go out.
 */
export async function sendTestEmail(to: string): Promise<SendOtpResult> {
  const provider = await getEmailProvider()
  const recipient = to.trim().toLowerCase()

  if (provider === 'dev') {
    return {
      delivered: false,
      devMode: true,
      message:
        'Email is not configured. Connect Gmail in the admin Email tab (no App Password) OR set SMTP_* (Brevo: 300/day free) OR RESEND_API_KEY (100/day free) in .env.',
    }
  }

  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:sans-serif;background:#f4f3ee;color:#2b2825;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #d9d4c7;"><h1 style="font-size:18px;color:#d4744f;margin:0 0 8px;">${APP_NAME} — test email</h1><p style="font-size:14px;color:#6b6557;line-height:1.5;">If you can read this, your email configuration is working correctly. Verification emails will be delivered to this address.</p></div></body></html>`
  const text = `${APP_NAME} — test email\n\nIf you can read this, your email configuration is working correctly. Verification emails will be delivered to this address.`
  const subject = `${APP_NAME} — email test`

  // ── Gmail OAuth2 ──
  if (provider === 'gmail-oauth') {
    const tokenInfo = await getFreshAccessToken()
    if (!tokenInfo) {
      return {
        delivered: false,
        devMode: false,
        message:
          'Gmail OAuth2 access token could not be refreshed. Disconnect and reconnect Gmail in the admin Email tab.',
      }
    }
    try {
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          type: 'OAuth2',
          user: tokenInfo.email,
          accessToken: tokenInfo.accessToken,
        },
      })
      await transporter.sendMail({
        from: tokenInfo.email,
        to: recipient,
        subject,
        html,
        text,
      })
      return {
        delivered: true,
        devMode: false,
        message: `Test email sent to ${recipient} via Gmail OAuth2 (${tokenInfo.email}).`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return {
        delivered: false,
        devMode: false,
        message: `Gmail OAuth2 error: ${reason}`,
      }
    }
  }

  // ── SMTP plain ──
  if (provider === 'smtp') {
    const from =
      process.env.SMTP_FROM?.trim() || process.env.SMTP_USER!.trim()
    try {
      const transporter = getSmtpTransporter()
      await transporter.sendMail({ from, to: recipient, subject, html, text })
      return {
        delivered: true,
        devMode: false,
        message: `Test email sent to ${recipient} via SMTP (${process.env.SMTP_HOST}).`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return {
        delivered: false,
        devMode: false,
        message: `SMTP error: ${reason}`,
      }
    }
  }

  // ── Resend ──
  const apiKey = process.env.RESEND_API_KEY!.trim()
  const from =
    process.env.RESEND_FROM?.trim() ||
    'Onyx Base <onboarding@resend.dev>'
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [recipient], subject, html, text }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      return {
        delivered: true,
        devMode: false,
        message: `Test email sent to ${recipient} via Resend API.`,
      }
    }
    const errBody = await res.json().catch(() => null)
    const reason =
      (errBody &&
        typeof errBody === 'object' &&
        'message' in errBody &&
        String(errBody.message)) ||
      `HTTP ${res.status} ${res.statusText}`
    return {
      delivered: false,
      devMode: false,
      message: `Failed: ${reason}`,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      delivered: false,
      devMode: false,
      message: `Network error: ${reason}`,
    }
  }
}

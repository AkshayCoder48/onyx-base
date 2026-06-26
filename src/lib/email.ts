/**
 * Onyx Base — email delivery (OTP / verification codes).
 *
 * LOCAL UNLIMITED FREE design
 * ───────────────────────────
 * The OTP system MUST work out-of-the-box in a fresh clone with ZERO external
 * configuration. So we have two modes:
 *
 *   1. Production mode (SMTP configured):
 *      SMTP_HOST + SMTP_PORT + SMTP_FROM are all set in .env → we use
 *      nodemailer to send a real HTML email with the 6-digit code. The code
 *      is NEVER returned in the API response (no `devCode` field).
 *
 *   2. Local dev mode (SMTP NOT configured):
 *      Any of SMTP_HOST / SMTP_PORT / SMTP_FROM is missing → we DON'T send any
 *      email. Instead we log the code to the server console AND return
 *      `{ delivered: false, devMode: true, devCode: <code> }` from the API
 *      route so the frontend can display it inline ("Dev mode: your code is
 *      123456"). This is the "local unlimited free" path — no SMTP provider,
 *      no API key, no rate limit, no cost.
 *
 * This module NEVER throws — `sendOtpEmail` always returns a result object.
 * A failure to send (e.g. SMTP misconfigured) is surfaced as
 * `{ delivered: false, devMode: false, message: '…' }` so the API route can
 * decide whether to fall back to dev mode or surface the error.
 */

import nodemailer, { type Transporter } from 'nodemailer'
import type { OtpPurpose } from '@/lib/otp'

/** App name shown in the OTP email subject + body. */
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Onyx Base'

/**
 * SMTP is "configured" only when host + port + from are ALL present. User and
 * password are technically optional (some relays accept unauthenticated
 * sends from inside a trusted network), so we don't gate on them.
 */
export function isSmtpConfigured(): boolean {
  const host = process.env.SMTP_HOST?.trim()
  const port = process.env.SMTP_PORT?.trim()
  const from = process.env.SMTP_FROM?.trim()
  return Boolean(host && port && from)
}

// ─── Lazy transporter (only created when SMTP is configured) ─────────────────
//
// We don't create the transporter at module-load time, because that would
// throw if SMTP_USER / SMTP_PASS are missing in dev mode (where SMTP isn't
// configured at all). Instead we create it on first use, and cache it on
// globalThis so hot reloads don't leak transporters.
const globalForMailer = globalThis as unknown as { __onyxMailer?: Transporter }
function getMailer(): Transporter | null {
  if (!isSmtpConfigured()) return null
  if (globalForMailer.__onyxMailer) return globalForMailer.__onyxMailer
  const host = process.env.SMTP_HOST!.trim()
  const port = Number(process.env.SMTP_PORT!.trim())
  const user = process.env.SMTP_USER?.trim() || undefined
  const pass = process.env.SMTP_PASS?.trim() || undefined
  const transporter = nodemailer.createTransport({
    host,
    port: Number.isFinite(port) ? port : 587,
    secure: Number.isFinite(port) && port === 465,
    auth: user && pass ? { user, pass } : undefined,
  })
  globalForMailer.__onyxMailer = transporter
  return transporter
}

/**
 * Human-readable label for the OTP purpose — shown in the email body so the
 * user knows WHY they're getting the code (and can spot a phishing attempt
 * where they get a "reset" code but didn't ask for one).
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
 * external CSS) so it renders correctly in Gmail / Outlook / Apple Mail —
 * which strip <style> tags. Warm-clay palette consistent with the dashboard.
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
  /** True if a real email was handed to SMTP for delivery. */
  delivered: boolean
  /** True when we're in local dev mode (SMTP not configured). */
  devMode: boolean
  /** Human-readable status — safe to log or surface to operators. */
  message: string
}

/**
 * Send (or, in dev mode, surface) an OTP code via email.
 *
 * Production mode: hands the message to nodemailer and awaits the SMTP
 * response. Returns `{ delivered: true, devMode: false }` on success.
 * On SMTP failure, returns `{ delivered: false, devMode: false, message }`
 * WITHOUT throwing — the caller decides whether to fall back to dev mode.
 *
 * Dev mode: doesn't send anything. Logs the code to the server console AND
 * returns `{ delivered: false, devMode: true, message }`. The caller (API
 * route) is responsible for including the plaintext code in the response
 * body as `devCode` so the frontend can display it.
 */
export async function sendOtpEmail(opts: {
  to: string
  code: string
  purpose: OtpPurpose
}): Promise<SendOtpResult> {
  const { to, code, purpose } = opts
  const recipient = to.trim().toLowerCase()

  // ── Dev mode: no SMTP configured → log + signal devMode ──
  if (!isSmtpConfigured()) {
    const msg = `[otp] dev mode — code for ${recipient} (${purpose}): ${code}`
    console.log(msg)
    return {
      delivered: false,
      devMode: true,
      message: 'SMTP not configured — OTP shown in server logs / API response (dev mode)',
    }
  }

  // ── Production mode: send a real email via nodemailer ──
  const from = process.env.SMTP_FROM!.trim()
  const subject = `Your ${APP_NAME} verification code`
  const html = buildOtpHtml({ code, purpose })
  const text = buildOtpText({ code, purpose })

  try {
    const mailer = getMailer()
    if (!mailer) {
      // Shouldn't happen (isSmtpConfigured returned true above) but guard anyway.
      return {
        delivered: false,
        devMode: false,
        message: 'SMTP transporter could not be created.',
      }
    }
    await mailer.sendMail({
      from,
      to: recipient,
      subject,
      html,
      text,
    })
    return {
      delivered: true,
      devMode: false,
      message: `Verification code sent to ${recipient}.`,
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[email] SMTP send failed for ${recipient} (${purpose}):`, reason)
    return {
      delivered: false,
      devMode: false,
      message: `Failed to send verification email: ${reason}`,
    }
  }
}

/**
 * Onyx Base — email delivery (OTP / verification codes).
 *
 * LOCAL UNLIMITED FREE design
 * ───────────────────────────────────────────────────────────
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
 * ROBUST SMTP DELIVERY
 * ───────────────────────────────────────────────────────────
 * Gmail (and most providers) can be picky about the connection. We try
 * MULTIPLE connection configurations in sequence until one works:
 *   1. Port 465 with `secure: true`  (implicit TLS — Gmail's preferred)
 *   2. Port 587 with `secure: false` + STARTTLS upgrade
 *   3. Port 465 with `secure: true` + `requireTLS: true` (force)
 *
 * If ALL fail with an auth error (535), we surface a crystal-clear message
 * telling the operator to generate a Gmail App Password (regular Gmail
 * passwords are blocked for SMTP since 2022).
 *
 * This module NEVER throws — `sendOtpEmail` always returns a result object.
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

// ─── Lazy transporter cache ────────────────────────────────────────────────
//
// We cache ONE transporter per connection-config on globalThis so hot reloads
// don't leak transporters. We try configs in order; the first that verifies
// is reused for all subsequent sends.
const globalForMailer = globalThis as unknown as {
  __onyxMailers?: Map<string, Transporter>
  __onyxMailerVerifiedKey?: string
}

interface SmtpConfig {
  key: string
  host: string
  port: number
  secure: boolean
  requireTLS?: boolean
}

/** Build the ordered list of SMTP configs to try. */
function buildConfigs(): SmtpConfig[] {
  const host = process.env.SMTP_HOST!.trim()
  const port = Number(process.env.SMTP_PORT!.trim())
  const configs: SmtpConfig[] = []

  // 1. The configured port with auto-detected secure flag.
  if (Number.isFinite(port)) {
    configs.push({
      key: `p${port}-secure${port === 465}`,
      host,
      port,
      secure: port === 465,
    })
    // 2. If the user picked 465, also try 587 STARTTLS as a fallback.
    if (port === 465) {
      configs.push({
        key: 'p587-starttls',
        host,
        port: 587,
        secure: false,
        requireTLS: true,
      })
    }
    // 3. If the user picked 587, also try 465 implicit SSL as a fallback.
    if (port === 587) {
      configs.push({
        key: 'p465-ssl',
        host,
        port: 465,
        secure: true,
      })
    }
  }

  return configs
}

/** Create (or fetch from cache) a transporter for a given config. */
function getOrCreateMailer(cfg: SmtpConfig): Transporter {
  if (!globalForMailer.__onyxMailers) {
    globalForMailer.__onyxMailers = new Map()
  }
  const cached = globalForMailer.__onyxMailers.get(cfg.key)
  if (cached) return cached

  const user = process.env.SMTP_USER?.trim() || undefined
  const pass = process.env.SMTP_PASS?.trim() || undefined

  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    requireTLS: cfg.requireTLS,
    auth: user && pass ? { user, pass } : undefined,
    // Generous timeouts so a hung connection doesn't block the request.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  })
  globalForMailer.__onyxMailers.set(cfg.key, transporter)
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
 * Detect whether an SMTP error is a Gmail auth failure (535 / BadCredentials)
 * and return a human-actionable hint. Gmail blocks regular account passwords
 * for SMTP since 2022 — the operator MUST generate a 16-char App Password.
 */
export function detectAuthFailure(message: string): string | null {
  if (/535|Username and Password not accepted|BadCredentials/i.test(message)) {
    return `Gmail rejected the SMTP credentials (535). Regular Gmail passwords are blocked for SMTP. Generate a 16-character App Password at https://myaccount.google.com/apppasswords (requires 2-Step Verification to be enabled on the account), then set SMTP_PASS to that App Password in your .env file.`
  }
  return null
}

/**
 * Send (or, in dev mode, surface) an OTP code via email.
 *
 * Production mode: tries multiple SMTP connection configs in sequence. Returns
 * `{ delivered: true, devMode: false }` on the first success. On total
 * failure, returns `{ delivered: false, devMode: false, message }` WITHOUT
 * throwing — the caller decides whether to fall back to dev mode.
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

  // ── Production mode: try each SMTP config until one works ──
  const from = process.env.SMTP_FROM!.trim()
  const subject = `Your ${APP_NAME} verification code`
  const html = buildOtpHtml({ code, purpose })
  const text = buildOtpText({ code, purpose })

  const configs = buildConfigs()
  const errors: string[] = []

  for (const cfg of configs) {
    try {
      const mailer = getOrCreateMailer(cfg)
      await mailer.sendMail({
        from,
        to: recipient,
        subject,
        html,
        text,
      })
      // Success — remember which config worked for next time.
      globalForMailer.__onyxMailerVerifiedKey = cfg.key
      console.log(`[email] sent OTP to ${recipient} via ${cfg.key}`)
      return {
        delivered: true,
        devMode: false,
        message: `Verification code sent to ${recipient}.`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      errors.push(`[${cfg.key}] ${reason}`)
      // If it's an auth failure, no point trying other configs — the
      // credentials are wrong regardless of port. Stop early.
      if (/535|Username and Password not accepted|BadCredentials/i.test(reason)) {
        console.error(`[email] SMTP auth failed for ${recipient} via ${cfg.key}:`, reason)
        const hint = detectAuthFailure(reason)
        return {
          delivered: false,
          devMode: false,
          message: hint ?? `Failed to send verification email: ${reason}`,
        }
      }
      // Other errors (connection timeout, network) → try the next config.
      console.warn(`[email] config ${cfg.key} failed for ${recipient}: ${reason}`)
    }
  }

  // All configs exhausted.
  const lastErr = errors[errors.length - 1] ?? 'Unknown SMTP error'
  console.error(`[email] all SMTP configs failed for ${recipient}:`, errors.join(' | '))
  return {
    delivered: false,
    devMode: false,
    message: `Failed to send verification email: ${lastErr}`,
  }
}

/**
 * Send a test email (used by the /api/admin/email/test endpoint). Reuses the
 * same multi-config retry logic as sendOtpEmail so the test accurately
 * reflects whether real OTP emails will go out.
 */
export async function sendTestEmail(to: string): Promise<SendOtpResult> {
  if (!isSmtpConfigured()) {
    return {
      delivered: false,
      devMode: true,
      message: 'SMTP is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in .env to enable real email delivery.',
    }
  }

  const recipient = to.trim().toLowerCase()
  const from = process.env.SMTP_FROM!.trim()
  const html = `<!doctype html><html><body style="margin:0;padding:24px;font-family:sans-serif;background:#f4f3ee;color:#2b2825;"><div style="max-width:480px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #d9d4c7;"><h1 style="font-size:18px;color:#d4744f;margin:0 0 8px;">${APP_NAME} — test email</h1><p style="font-size:14px;color:#6b6557;line-height:1.5;">If you can read this, your SMTP configuration is working correctly. Verification emails will be delivered to this address.</p></div></body></html>`
  const text = `${APP_NAME} — test email\n\nIf you can read this, your SMTP configuration is working correctly. Verification emails will be delivered to this address.`

  const configs = buildConfigs()
  const errors: string[] = []

  for (const cfg of configs) {
    try {
      const mailer = getOrCreateMailer(cfg)
      await mailer.sendMail({
        from,
        to: recipient,
        subject: `${APP_NAME} — SMTP test`,
        html,
        text,
      })
      globalForMailer.__onyxMailerVerifiedKey = cfg.key
      return {
        delivered: true,
        devMode: false,
        message: `Test email sent to ${recipient} via ${cfg.key}.`,
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      errors.push(`[${cfg.key}] ${reason}`)
      if (/535|Username and Password not accepted|BadCredentials/i.test(reason)) {
        const hint = detectAuthFailure(reason)
        return {
          delivered: false,
          devMode: false,
          message: hint ?? reason,
        }
      }
    }
  }

  return {
    delivered: false,
    devMode: false,
    message: `Failed: ${errors.join(' | ')}`,
  }
}

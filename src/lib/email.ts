/**
 * Onyx Base — OTP code surface (dev mode only).
 *
 * Email delivery has been removed. The 6-digit OTP code is ALWAYS surfaced
 * inline (returned as `devCode` in the API response + logged to the server
 * console + shown in the UI). No email is ever sent.
 *
 * This keeps the signup / login / password-reset OTP flow fully functional
 * without any external email provider configuration.
 */

import type { OtpPurpose } from '@/lib/otp'

/** App name shown in logs. */
const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME || 'Onyx Base'

/** Provider type — always 'dev' now. */
export type EmailProvider = 'dev'

/** Always returns 'dev' — email delivery is removed. */
export function getEmailProvider(): EmailProvider {
  return 'dev'
}

/** Always returns false — no real email delivery is configured. */
export function isEmailConfigured(): boolean {
  return false
}

/** Backward-compatible alias. */
export const isSmtpConfigured = isEmailConfigured

/** Human-readable label. */
export function getProviderLabel(): string {
  return 'Dev mode (code shown inline — no email sent)'
}

export interface SendOtpResult {
  delivered: boolean
  devMode: boolean
  message: string
}

/**
 * Surface the OTP code in dev mode. Logs to the server console and signals
 * devMode so the caller (API route) includes the plaintext code as `devCode`
 * in the response for the frontend to display inline.
 */
export async function sendOtpEmail(opts: {
  to: string
  code: string
  purpose: OtpPurpose
}): Promise<SendOtpResult> {
  const { to, code, purpose } = opts
  const recipient = to.trim().toLowerCase()
  console.log(`[otp] dev mode — code for ${recipient} (${purpose}): ${code}`)
  return {
    delivered: false,
    devMode: true,
    message: `Dev mode — verification code shown inline. (${APP_NAME})`,
  }
}

/** Test email — always returns dev mode (no email is sent). */
export async function sendTestEmail(_to: string): Promise<SendOtpResult> {
  return {
    delivered: false,
    devMode: true,
    message: 'Email delivery is not configured. OTP codes are shown inline (dev mode).',
  }
}

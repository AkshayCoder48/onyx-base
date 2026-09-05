import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * POST /api/email-otp/send — DEPRECATED (Email Automation migration).
 *
 * The Email OTP system was replaced by the privacy-first Email Automation
 * API. Per the migration policy this endpoint returns 410 Gone with a
 * machine-readable migration body instead of silently routing old clients
 * through any credential. There is no project-wide fallback — each caller
 * must reference their own NAMED credential.
 *
 * Migration:
 *   OLD:  POST /api/email-otp/send { "email": "user@example.com" }
 *   NEW:  1. POST /api/credentials/connect
 *             { "name": "personal_email", "apiKey": "mcpe_…" }
 *         2. POST /api/email/send
 *             { "credential": "personal_email",
 *               "to": "user@example.com",
 *               "subject": "Your verification code",
 *               "body": "Your code is $OTP$.",
 *               "variables": { "OTP": "483921" } }
 *         (generate the 6-digit code in YOUR application — the API is a
 *          generic email automation engine, OTP is just one use case)
 *
 * Docs: /docs#email · OpenAPI: /api/openapi.json
 */
const MIGRATION = {
  deprecated: true,
  sunset: '2026-09-05',
  code: 'deprecated',
  error:
    'POST /api/email-otp/send is deprecated and has been replaced by the Email Automation API. It was NOT processed. See the "migration" field.',
  migration: {
    newEndpoint: '/api/email/send',
    setupEndpoint: '/api/credentials/connect',
    docs: '/docs#email',
    openapi: '/api/openapi.json',
    otpHint:
      'Generate the 6-digit code in your application, then send it as the $OTP$ variable: { "credential": "personal_email", "to": "...", "subject": "Your code", "body": "Your code is $OTP$.", "variables": { "OTP": "123456" } }',
  },
}

export async function POST(_req: NextRequest) {
  return Response.json({ ok: false, ...MIGRATION }, {
    status: 410,
    headers: {
      Allow: 'POST',
      Link: '</docs#email>; rel="deprecation"',
      Sunset: 'Sat, 05 Sep 2026 00:00:00 GMT',
    },
  })
}

export async function GET() {
  return Response.json({ ok: false, ...MIGRATION }, { status: 410 })
}

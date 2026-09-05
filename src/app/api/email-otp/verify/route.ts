import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * POST /api/email-otp/verify — DEPRECATED (Email Automation migration).
 *
 * OTP verification was an application-level concern of the retired OTP
 * system. The Email Automation API is a generic delivery engine — generate
 * AND verify codes in your application, and use /api/email/send to deliver
 * them as the $OTP$ variable. Returns 410 Gone with a machine-readable
 * migration body; no request is processed and no credential is used.
 *
 * Docs: /docs#email · OpenAPI: /api/openapi.json
 */
const MIGRATION = {
  deprecated: true,
  sunset: '2026-09-05',
  code: 'deprecated',
  error:
    'POST /api/email-otp/verify is deprecated. Verify codes in your application; deliver them with POST /api/email/send ($OTP$ variable). It was NOT processed. See the "migration" field.',
  migration: {
    newEndpoint: '/api/email/send',
    setupEndpoint: '/api/credentials/connect',
    docs: '/docs#email',
    openapi: '/api/openapi.json',
    otpHint:
      'Keep the issued code + expiry in YOUR app store, then email it: { "credential": "personal_email", "to": "...", "body": "Your code is $OTP$.", "variables": { "OTP": "123456" } }',
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

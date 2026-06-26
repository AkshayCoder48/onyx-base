import { NextRequest } from 'next/server'
import { ok, getPublicOrigin } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * GET /api/config — returns runtime configuration for CLI/SDK discovery.
 *
 * The public URL is derived from the gateway's forwarded headers (or the
 * `NEXT_PUBLIC_APP_URL` env var). This lets the CLI and external SDKs
 * auto-discover the hosted endpoint instead of hard-coding localhost.
 */
export async function GET(req: NextRequest) {
  return ok({
    publicUrl: getPublicOrigin(req),
    name: 'Onyx Base',
    description: 'Telegram-backed key-value store',
    storage: 'telegram',
  })
}

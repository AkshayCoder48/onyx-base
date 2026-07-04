/**
 * Onyx Base — CORS middleware + IP allowlist.
 *
 * NOTE: This is the legacy `middleware.ts` (not Next.js 16's `proxy.ts`)
 * because Cloudflare Workers requires Edge Runtime for middleware, and
 * Next.js 16's `proxy.ts` forces Node.js runtime (incompatible). The
 * `middleware.ts` form still supports `runtime = 'edge'`.
 *
 * Two concerns handled here so every API request goes through ONE place:
 *
 * 1. CORS — external HTML pages, browser-based SDKs, and other origins need
 *    to be able to call the REST API (/v1/*) and the dashboard API (/api/*).
 *    Without explicit CORS headers, browsers block the response and the
 *    fetch() promise rejects with a generic "Failed to fetch" error — even
 *    though the server actually processed the request.
 *
 *    We allow any origin (echo back the request Origin) and the methods /
 *    headers the SDKs and the dashboard use. Preflight (OPTIONS) requests
 *    are answered with 204 No Content.
 *
 * 2. IP allowlist — optional defence-in-depth. When `IP_ALLOWLIST` env var
 *    is set OR the runtime allowlist (mutated via /api/admin/network) has
 *    entries, only requests from matching IPs / CIDRs are allowed. When
 *    both are empty, every IP is allowed (default open).
 */

import { NextResponse, type NextRequest } from 'next/server'
import {
  isRequestIpAllowed,
  isAllowlistEnabled,
  getClientIp,
} from '@/lib/ip-allowlist'

// Edge Runtime is required for middleware on Cloudflare Workers.
// The ip-allowlist module uses only process.env + pure JS (no Node fs/net),
// so it is fully edge-compatible.
export const config = {
  matcher: ['/api/:path*', '/v1/:path*'],
}

export function middleware(req: NextRequest) {
  const origin = req.headers.get('origin') || '*'

  // ── IP allowlist enforcement ──────────────────────────────────────────────
  // Skip when allowlist is disabled (the common case) — zero overhead.
  if (isAllowlistEnabled()) {
    // Preflight (OPTIONS) is always allowed — it carries no auth and is
    // harmless. We don't want to break browser CORS handshakes from a
    // newly-allowed IP just because the OPTIONS didn't come from the right
    // network (which it might, via the browser, not the SDK host).
    if (req.method !== 'OPTIONS' && !isRequestIpAllowed(req)) {
      const ip = getClientIp(req)
      return NextResponse.json(
        {
          ok: false,
          error: 'Forbidden — your IP address is not on the allowlist.',
          ip,
          hint: 'Ask the operator to add your IP to IP_ALLOWLIST or via POST /api/admin/network.',
        },
        {
          status: 403,
          headers: {
            'Access-Control-Allow-Origin': origin,
            'Content-Type': 'application/json; charset=utf-8',
          },
        },
      )
    }
  }

  // Handle CORS preflight.
  if (req.method === 'OPTIONS') {
    const res = new NextResponse(null, { status: 204 })
    res.headers.set('Access-Control-Allow-Origin', origin)
    res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
    res.headers.set(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type, X-Requested-With, Accept, X-Api-Key',
    )
    res.headers.set('Access-Control-Max-Age', '86400')
    res.headers.set('Access-Control-Allow-Credentials', 'true')
    return res
  }

  // For non-preflight requests, add CORS headers to the response.
  const res = NextResponse.next()
  res.headers.set('Access-Control-Allow-Origin', origin)
  res.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS')
  res.headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With, Accept, X-Api-Key')
  res.headers.set('Access-Control-Allow-Credentials', 'true')
  res.headers.set('Vary', 'Origin')
  return res
}

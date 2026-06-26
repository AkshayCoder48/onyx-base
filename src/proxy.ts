/**
 * Onyx Base — CORS proxy (Next.js 16 renamed middleware → proxy).
 *
 * External HTML pages, browser-based SDKs, and other origins need to be able to
 * call the REST API (/v1/*) and the dashboard API (/api/*). Without explicit
 * CORS headers, browsers block the response and the fetch() promise rejects
 * with a generic "Failed to fetch" error — even though the server actually
 * processed the request.
 *
 * We allow any origin (echo back the request Origin) and the methods/headers
 * the SDKs and the dashboard use. Preflight (OPTIONS) requests are answered
 * with 204 No Content.
 */

import { NextResponse, type NextRequest } from 'next/server'

export function proxy(req: NextRequest) {
  const origin = req.headers.get('origin') || '*'

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

export const config = {
  // Apply CORS to all API routes (REST + dashboard) and the config endpoint.
  matcher: ['/api/:path*', '/v1/:path*'],
}

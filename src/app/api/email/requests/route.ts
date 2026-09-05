import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { listEmailRequests } from '@/lib/email-request-log'

export const runtime = 'nodejs'

/**
 * GET /api/email/requests — recent email automation requests for the caller
 * (metadata only, newest first; see email-request-log.ts for the exact
 * non-sensitive field list). Used by the dashboard "Recent sends" list and
 * by automation clients that poll outcomes.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  const requests = listEmailRequests(user.dbUserId).map((e) => ({
    request_id: e.requestId,
    ts: e.ts,
    endpoint: e.endpoint,
    credential: e.credential,
    status: e.status,
    latency_ms: e.latencyMs,
    ...(e.upstreamStatus !== undefined ? { upstream_status: e.upstreamStatus } : {}),
    ...(e.errorCode ? { error_code: e.errorCode } : {}),
  }))
  return ok({ requests })
}

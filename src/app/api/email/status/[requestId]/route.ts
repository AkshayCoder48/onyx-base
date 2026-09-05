import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import { findEmailRequest } from '@/lib/email-request-log'

export const runtime = 'nodejs'

/**
 * GET /api/email/status/[requestId] — status of a previous email request
 * (PRD §22: debug by request ID, never by exposing request content).
 *
 * Returns metadata ONLY:
 *   { request_id, ts, endpoint, credential, status: 'sent'|'failed',
 *     latency_ms, upstream_status?, error_code? }
 *
 * 404 request_not_found when the ID is unknown on this account (IDs are
 * tenant-scoped: user A cannot probe user B's request IDs) or older than the
 * 7-day retention window.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401, { code: 'invalid_api_key' })
  const z = authorize(user, req, { scope: 'read' })
  if (!z.ok) return authorizeFailResponse(z)

  const { requestId } = await params
  const id = decodeURIComponent(requestId)
  // NOTE: request IDs are base64url (`req_` + [a-z0-9_-]) — dashes and
  // underscores are VALID ID characters and must be accepted here.
  if (!/^req_[a-z0-9_-]{8,64}$/i.test(id)) {
    return fail('Invalid request ID format (expected req_…).', 400, { code: 'bad_request' })
  }

  const entry = findEmailRequest(user.dbUserId, id)
  if (!entry) {
    return fail(
      `No email request ${id} found for this account (retention is 7 days; cross-instance entries appear once the metadata snapshot syncs).`,
      404,
      { code: 'request_not_found' },
    )
  }

  return ok({
    request_id: entry.requestId,
    ts: entry.ts,
    endpoint: entry.endpoint,
    credential: entry.credential,
    status: entry.status,
    latency_ms: entry.latencyMs,
    ...(entry.upstreamStatus !== undefined ? { upstream_status: entry.upstreamStatus } : {}),
    ...(entry.errorCode ? { error_code: entry.errorCode } : {}),
  })
}

import { NextRequest } from 'next/server'
import { authenticateAdmin, ok, fail } from '@/lib/auth'
import {
  getEnvAllowlist,
  getRuntimeAllowlist,
  setRuntimeAllowlist,
  isAllowlistEnabled,
  getClientIp,
} from '@/lib/ip-allowlist'

export const runtime = 'nodejs'

/**
 * GET /api/admin/network
 * Auth: Bearer onyxbase_...
 *
 * Returns the current IP allowlist configuration:
 *   - env (operator-configured via IP_ALLOWLIST, read-only here)
 *   - runtime (mutable via POST; persisted in-memory only)
 *   - enabled (true when either list is non-empty)
 *   - yourIp (the caller's resolved IP, for convenience)
 */
export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  return ok({
    enabled: isAllowlistEnabled(),
    env: getEnvAllowlist(),
    runtime: getRuntimeAllowlist(),
    yourIp: getClientIp(req),
    note:
      'When `enabled` is false, all IPs are allowed. ' +
      'POST { allowlist: [...] } to replace the runtime list. ' +
      'POST { add: "1.2.3.4" } / { remove: "1.2.3.4" } to mutate. ' +
      'Env entries (IP_ALLOWLIST) are read-only from this endpoint.',
  })
}

/**
 * POST /api/admin/network
 * Auth: Bearer onyxbase_...
 *
 * Mutate the runtime allowlist. Accepted bodies:
 *   - { allowlist: ["1.2.3.4", "10.0.0.0/8"] }  → replace the entire runtime list
 *   - { add: "1.2.3.4" }                         → append a single entry
 *   - { remove: "1.2.3.4" }                      → drop a single entry
 *
 * Runtime mutations are in-memory only — they do NOT persist across server
 * restarts. For permanent rules, set the IP_ALLOWLIST env var.
 */
export async function POST(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return fail('JSON body required.', 400)
  }

  // Replace-whole mode.
  if (Array.isArray(body.allowlist)) {
    const cleaned = body.allowlist
      .map((s: unknown) => (typeof s === 'string' ? s.trim() : ''))
      .filter(Boolean)
    setRuntimeAllowlist(cleaned)
    return ok({
      action: 'replace',
      runtime: getRuntimeAllowlist(),
      env: getEnvAllowlist(),
      enabled: isAllowlistEnabled(),
    })
  }

  // Add-single mode.
  if (typeof body.add === 'string' && body.add.trim()) {
    const entry = body.add.trim()
    const current = new Set(getRuntimeAllowlist())
    current.add(entry)
    setRuntimeAllowlist(Array.from(current))
    return ok({
      action: 'add',
      entry,
      runtime: getRuntimeAllowlist(),
      env: getEnvAllowlist(),
      enabled: isAllowlistEnabled(),
    })
  }

  // Remove-single mode.
  if (typeof body.remove === 'string' && body.remove.trim()) {
    const entry = body.remove.trim()
    const current = new Set(getRuntimeAllowlist())
    if (!current.has(entry)) {
      return fail(`Entry "${entry}" not found in the runtime allowlist.`, 404)
    }
    current.delete(entry)
    setRuntimeAllowlist(Array.from(current))
    return ok({
      action: 'remove',
      entry,
      runtime: getRuntimeAllowlist(),
      env: getEnvAllowlist(),
      enabled: isAllowlistEnabled(),
    })
  }

  return fail(
    'Body must be one of: { allowlist: string[] } | { add: string } | { remove: string }.',
    400,
  )
}

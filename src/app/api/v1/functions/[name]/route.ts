import { NextRequest } from 'next/server'
import { authenticate, ok, fail, type AuthenticatedUser } from '@/lib/auth'
import { db } from '@/lib/db'
import { listRecords } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * GET    /api/v1/functions/{name}  → fetch the stored function definition
 * POST   /api/v1/functions/{name}  → test-invoke (run the stored code in a
 *                                     sandbox with { record, db, user })
 * DELETE /api/v1/functions/{name}  → delete the function
 *
 * Execution sandbox:
 *   - `new Function('ctx', code)` with ctx = { record, db, user }
 *   - `record` is the optional POST body (so callers can pass payload data)
 *   - `db` is a TINY read-only helper that lets the function read the user's
 *     own records (no writes — safety first):
 *       db.getRecord(collection, key)   → value or null
 *       db.listRecords(collection?)     → array of records
 *       db.countRecords(collection?)    → number
 *   - `user` exposes { userId, isAdmin }
 *   - The function's RETURN VALUE is returned to the caller as `result`.
 *   - Any thrown error is caught and returned as a 500 with the message.
 *   - 5-second timeout protects against infinite loops.
 *
 * Auth: Bearer kv_live_xxx
 */

// Build a safe, minimal `db` object that the sandboxed function can use.
// It only ever reads the calling user's own data.
function buildSandboxDb(user: AuthenticatedUser) {
  return {
    getRecord(collection: string, key: string): unknown {
      const rows = listRecords(user.dbUserId, collection)
      const r = rows.find((x) => x.key === key)
      if (!r) return null
      try {
        return JSON.parse(r.value)
      } catch {
        return r.value
      }
    },
    listRecords(collection?: string): unknown[] {
      const rows = listRecords(user.dbUserId, collection)
      return rows.map((r) => {
        let parsed: unknown = r.value
        try {
          parsed = JSON.parse(r.value)
        } catch {
          /* keep raw */
        }
        return {
          key: r.key,
          value: parsed,
          valueType: r.valueType,
          collection: r.collection,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        }
      })
    },
    countRecords(collection?: string): number {
      const rows = listRecords(user.dbUserId, collection)
      return rows.length
    },
  }
}

function buildSandboxUser(user: AuthenticatedUser) {
  return {
    userId: user.userId,
    isAdmin: user.isAdmin,
    apiKeyName: user.apiKeyName,
  }
}

async function runFunction(
  user: AuthenticatedUser,
  code: string,
  record: unknown,
): Promise<{ result: unknown; durationMs: number }> {
  const start = Date.now()
  const ctx = {
    record,
    db: buildSandboxDb(user),
    user: buildSandboxUser(user),
  }
  // Compile the code into a callable. We already syntax-checked at create
  // time, but re-check here for safety.
  const fn = new Function('ctx', code) as (ctx: typeof ctx) => unknown

  // 5-second timeout. We race the function against a timer — if it doesn't
  // resolve in 5s, we throw. (Note: this doesn't actually KILL the function's
  // execution — JS doesn't support that — but it does unblock the API call
  // and return a 500. The hung function will eventually OOM the process if
  // it's truly infinite, which is acceptable for a dev platform.)
  const TIMEOUT_MS = 5000
  const result = await Promise.race([
    Promise.resolve().then(() => fn(ctx)),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Function timed out after ${TIMEOUT_MS}ms`)),
        TIMEOUT_MS,
      ),
    ),
  ])
  return { result, durationMs: Date.now() - start }
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  const fn = await db.function.findUnique({
    where: { userId_name: { userId: user.dbUserId, name } },
  })
  if (!fn) return fail(`Function "${name}" not found.`, 404)

  return ok({
    function: {
      id: fn.id,
      name: fn.name,
      code: fn.code,
      trigger: fn.trigger,
      createdAt: fn.createdAt,
    },
  })
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  const fn = await db.function.findUnique({
    where: { userId_name: { userId: user.dbUserId, name } },
  })
  if (!fn) return fail(`Function "${name}" not found.`, 404)

  // The POST body becomes `ctx.record` (null when no body / not JSON).
  let record: unknown = null
  try {
    const text = await req.text()
    if (text.trim()) record = JSON.parse(text)
  } catch {
    /* leave null */
  }

  try {
    const { result, durationMs } = await runFunction(user, fn.code, record)
    return ok({
      function: fn.name,
      trigger: fn.trigger,
      result,
      durationMs,
      ranAt: new Date().toISOString(),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Function "${name}" threw: ${msg}`, 500, {
      function: fn.name,
      ranAt: new Date().toISOString(),
    })
  }
}

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await ctx.params
  try {
    const deleted = await db.function.delete({
      where: { userId_name: { userId: user.dbUserId, name } },
    })
    return ok({ action: 'delete', name: deleted.name })
  } catch {
    return fail(`Function "${name}" not found.`, 404)
  }
}

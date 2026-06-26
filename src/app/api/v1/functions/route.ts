import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * GET  /api/v1/functions        → list the caller's functions
 * POST /api/v1/functions        → create a server-side JS function
 *   Body { name, code, trigger? }
 *
 * Functions store user-defined JS code as a string. When triggered they run
 * in a sandboxed `new Function('ctx', code)` context with access to a
 * restricted context object { record, db, user }.
 *
 * Auth: Bearer kv_live_xxx
 */

const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/

export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const rows = await db.function.findMany({
    where: { userId: user.dbUserId },
    orderBy: { name: 'asc' },
  })
  return ok({
    functions: rows.map((f) => ({
      id: f.id,
      name: f.name,
      code: f.code,
      trigger: f.trigger,
      createdAt: f.createdAt,
    })),
    count: rows.length,
  })
}

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const body = await req.json().catch(() => null)
  if (!body) return fail('JSON body required.', 400)

  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const code = typeof body.code === 'string' ? body.code : ''
  const trigger =
    typeof body.trigger === 'string' && body.trigger.trim()
      ? body.trigger.trim()
      : 'manual'

  if (!NAME_RE.test(name)) {
    return fail('`name` must start with a letter and contain only [A-Za-z0-9_-], max 64 chars.', 400)
  }
  if (!code.trim()) {
    return fail('`code` (non-empty string) is required.', 400)
  }
  if (code.length > 64 * 1024) {
    return fail('`code` is too large (max 64 KB).', 400)
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(trigger)) {
    return fail('`trigger` must be a short identifier (e.g. manual, set, delete).', 400)
  }

  // Compile-check the code up front so we can return a syntax error BEFORE
  // storing it. `new Function('ctx', code)` throws SyntaxError on bad code.
  try {
    new Function('ctx', code)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return fail(`Function code has a syntax error: ${msg}`, 400)
  }

  try {
    const created = await db.function.create({
      data: { userId: user.dbUserId, name, code, trigger },
    })
    return ok({
      function: {
        id: created.id,
        name: created.name,
        code: created.code,
        trigger: created.trigger,
        createdAt: created.createdAt,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('Unique constraint')) {
      return fail(`Function "${name}" already exists. Use a different name or DELETE it first.`, 409)
    }
    return fail(`Failed to create function: ${msg}`, 500)
  }
}

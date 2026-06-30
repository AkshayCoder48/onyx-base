import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import {
  describeUserTable,
  dropUserTable,
  updateAccessMode,
  validateAccessMode,
  ValidationError,
} from '@/lib/user-tables'

export const runtime = 'nodejs'

/**
 * GET /v1/tables/[name] — describe a table (schema + sample rows).
 * PATCH /v1/tables/[name] — update access mode. Body: { accessMode }
 * DELETE /v1/tables/[name] — drop a table.
 *
 * Auth: `Authorization: Bearer kv_live_…` (or admin key)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await params
  const z = authorize(user, req, { scope: 'tables', table: name })
  if (!z.ok) return authorizeFailResponse(z)

  try {
    const result = await describeUserTable(user.dbUserId, name)
    return ok({ table: result })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 404)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to describe table: ${reason}`, 500)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await params
  const z = authorize(user, req, { scope: 'tables', table: name })
  if (!z.ok) return authorizeFailResponse(z)

  const body = (await req.json().catch(() => null)) as {
    accessMode?: unknown
  } | null
  if (!body) return fail('Request body must be a JSON object.', 400)

  try {
    const accessMode = validateAccessMode(body.accessMode)
    const meta = await updateAccessMode(user.dbUserId, name, accessMode)
    return ok({ table: meta, message: 'Access mode updated' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 404)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to update table: ${reason}`, 500)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const { name } = await params
  const z = authorize(user, req, { scope: 'tables', table: name })
  if (!z.ok) return authorizeFailResponse(z)

  try {
    await dropUserTable(user.dbUserId, name)
    return ok({ message: 'Table dropped' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 404)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to drop table: ${reason}`, 500)
  }
}

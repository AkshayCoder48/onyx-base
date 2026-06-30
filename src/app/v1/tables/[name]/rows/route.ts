import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import {
  findUserTable,
  listRows,
  insertRow,
  updateRow,
  deleteRow,
  canRead,
  canWrite,
  ValidationError,
} from '@/lib/user-tables'

export const runtime = 'nodejs'

/**
 * Row-level CRUD for a table, accessible via the public v1 API.
 *
 * Access-mode enforcement:
 *   read      → GET only
 *   write     → POST / PATCH / DELETE only
 *   readwrite → everything
 *
 * Auth: `Authorization: Bearer kv_live_…` (or admin key)
 */

async function resolveOwner(req: NextRequest, name: string) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return null
  const meta = await findUserTable(user.dbUserId, name)
  if (!meta) return { user, meta: null }
  return { user, meta }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const ctx = await resolveOwner(req, name)
  if (!ctx) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(ctx.user, req, { scope: 'tables', table: name })
  if (!z.ok) return authorizeFailResponse(z)

  if (!ctx.meta) return fail(`Table "${name}" does not exist.`, 404)
  if (!canRead(ctx.meta.accessMode)) {
    return fail(
      `Table "${name}" is write-only — reads are disabled by its access mode.`,
      403,
    )
  }

  const limitParam = req.nextUrl.searchParams.get('limit')
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 100, 1000) : 100
  try {
    const rows = await listRows(ctx.user.dbUserId, name, limit)
    return ok({ rows, count: rows.length })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to list rows: ${reason}`, 500)
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const ctx = await resolveOwner(req, name)
  if (!ctx) return fail('Unauthorized — invalid or missing API key.', 401)

  if (!ctx.meta) return fail(`Table "${name}" does not exist.`, 404)
  if (!canWrite(ctx.meta.accessMode)) {
    return fail(
      `Table "${name}" is read-only — writes are disabled by its access mode.`,
      403,
    )
  }

  const body = (await req.json().catch(() => null)) as {
    row?: unknown
  } | null
  if (!body || typeof body.row !== 'object' || body.row === null) {
    return fail('`row` (object) is required.', 400)
  }

  const z = authorize(ctx.user, req, {
    scope: 'tables',
    table: name,
    bytesWritten: Buffer.byteLength(JSON.stringify(body.row)),
  })
  if (!z.ok) return authorizeFailResponse(z)

  try {
    const inserted = await insertRow(
      ctx.user.dbUserId,
      name,
      body.row as Record<string, unknown>,
    )
    return ok({ row: inserted, message: 'Row inserted' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 400)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to insert row: ${reason}`, 500)
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const ctx = await resolveOwner(req, name)
  if (!ctx) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(ctx.user, req, { scope: 'tables', table: name })
  if (!z.ok) return authorizeFailResponse(z)

  if (!ctx.meta) return fail(`Table "${name}" does not exist.`, 404)
  if (!canWrite(ctx.meta.accessMode)) {
    return fail(
      `Table "${name}" is read-only — writes are disabled by its access mode.`,
      403,
    )
  }

  const body = (await req.json().catch(() => null)) as {
    pk?: unknown
    patch?: unknown
  } | null
  if (!body || typeof body.pk !== 'object' || body.pk === null) {
    return fail('`pk` (object) is required.', 400)
  }
  if (!body.patch || typeof body.patch !== 'object') {
    return fail('`patch` (object) is required.', 400)
  }
  try {
    await updateRow(
      ctx.user.dbUserId,
      name,
      body.pk as Record<string, unknown>,
      body.patch as Record<string, unknown>,
    )
    return ok({ message: 'Row updated' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 400)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to update row: ${reason}`, 500)
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params
  const ctx = await resolveOwner(req, name)
  if (!ctx) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(ctx.user, req, { scope: 'tables', table: name })
  if (!z.ok) return authorizeFailResponse(z)

  if (!ctx.meta) return fail(`Table "${name}" does not exist.`, 404)
  if (!canWrite(ctx.meta.accessMode)) {
    return fail(
      `Table "${name}" is read-only — writes are disabled by its access mode.`,
      403,
    )
  }

  const body = (await req.json().catch(() => null)) as {
    pk?: unknown
  } | null
  if (!body || typeof body.pk !== 'object' || body.pk === null) {
    return fail('`pk` (object) is required.', 400)
  }
  try {
    await deleteRow(ctx.user.dbUserId, name, body.pk as Record<string, unknown>)
    return ok({ message: 'Row deleted' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 400)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to delete row: ${reason}`, 500)
  }
}

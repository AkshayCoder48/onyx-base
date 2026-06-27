import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import {
  listRows,
  insertRow,
  updateRow,
  deleteRow,
  ValidationError,
} from '@/lib/user-tables'

export const runtime = 'nodejs'

// ─── GET /api/dashboard/tables/[name]/rows ──────────────────────────────────
/** List rows (up to 100) in a table owned by the authenticated developer. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { name } = await params
  const limitParam = req.nextUrl.searchParams.get('limit')
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 100, 1000) : 100

  try {
    const rows = await listRows(user.dbUserId, name, limit)
    return ok({ rows, count: rows.length })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 404)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to list rows: ${reason}`, 500)
  }
}

// ─── POST /api/dashboard/tables/[name]/rows ─────────────────────────────────
/** Insert a new row. Body: { row: { col: value, ... } } */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { name } = await params
  const body = (await req.json().catch(() => null)) as {
    row?: unknown
  } | null
  if (!body || typeof body.row !== 'object' || body.row === null) {
    return fail('`row` (object) is required.', 400)
  }

  try {
    const inserted = await insertRow(user.dbUserId, name, body.row as Record<string, unknown>)
    return ok({ row: inserted, message: 'Row inserted' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 400)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to insert row: ${reason}`, 500)
  }
}

// ─── PATCH /api/dashboard/tables/[name]/rows ────────────────────────────────
/** Update a row by PK. Body: { pk: { col: value }, patch: { col: value } } */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { name } = await params
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
      user.dbUserId,
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

// ─── DELETE /api/dashboard/tables/[name]/rows ───────────────────────────────
/** Delete a row by PK. Body: { pk: { col: value } } */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { name } = await params
  const body = (await req.json().catch(() => null)) as {
    pk?: unknown
  } | null
  if (!body || typeof body.pk !== 'object' || body.pk === null) {
    return fail('`pk` (object) is required.', 400)
  }

  try {
    await deleteRow(user.dbUserId, name, body.pk as Record<string, unknown>)
    return ok({ message: 'Row deleted' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 400)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to delete row: ${reason}`, 500)
  }
}

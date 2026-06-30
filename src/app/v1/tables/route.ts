import { NextRequest } from 'next/server'
import { authenticate, authorize, authorizeFailResponse, ok, fail } from '@/lib/auth'
import {
  listUserTables,
  createUserTable,
  validateColumns,
  validateTableName,
  validateAccessMode,
  ValidationError,
  type ColumnDef,
} from '@/lib/user-tables'

export const runtime = 'nodejs'

/**
 * GET /v1/tables — list every table owned by the caller.
 * POST /v1/tables — create a new table.
 *
 * Auth: `Authorization: Bearer kv_live_…` (or `onyxbase_…` admin key)
 *
 * Works with every API key type — live keys, test keys, and admin keys all
 * resolve to a user and only ever see that user's own tables.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const z = authorize(user, req, { scope: 'tables' })
  if (!z.ok) return authorizeFailResponse(z)

  try {
    const tables = await listUserTables(user.dbUserId)
    return ok({
      tables,
      count: tables.length,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to list tables: ${reason}`, 500)
  }
}

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const body = (await req.json().catch(() => null)) as {
    name?: unknown
    columns?: unknown
    accessMode?: unknown
  } | null
  if (!body || typeof body !== 'object') {
    return fail('Request body must be a JSON object.', 400)
  }

  try {
    const name = validateTableName(body.name)
    const columns = validateColumns(body.columns) as ColumnDef[]
    const accessMode = validateAccessMode(body.accessMode)

    const z = authorize(user, req, {
      scope: 'tables',
      table: name,
      bytesWritten: Buffer.byteLength(JSON.stringify(body)),
    })
    if (!z.ok) return authorizeFailResponse(z)

    const meta = await createUserTable(user.dbUserId, name, columns, accessMode)
    return ok({ table: meta, message: 'Table created' })
  } catch (err) {
    if (err instanceof ValidationError) {
      return fail(err.message, 400)
    }
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to create table: ${reason}`, 500)
  }
}

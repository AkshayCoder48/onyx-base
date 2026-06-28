import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import {
  listUserTables,
  createUserTable,
  validateColumns,
  validateTableName,
  validateAccessMode,
  ValidationError,
  type UserTableMeta,
  type ColumnDef,
} from '@/lib/user-tables'

export const runtime = 'nodejs'

// ─── Types ──────────────────────────────────────────────────────────────────

interface TablesListResponse {
  tables: UserTableMeta[]
}

interface CreateBody {
  name?: unknown
  columns?: unknown
  accessMode?: unknown
}

// ─── GET /api/dashboard/tables ──────────────────────────────────────────────
/**
 * Returns every table owned by the authenticated developer. Tables are
 * account-scoped — you only see your own tables, never another developer's.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  try {
    const tables = await listUserTables(user.dbUserId)
    return ok<TablesListResponse>({ tables })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to list tables: ${reason}`, 500)
  }
}

// ─── POST /api/dashboard/tables ─────────────────────────────────────────────
/**
 * Create a new account-scoped table.
 *
 * Body: { name: string, columns: ColumnDef[], accessMode?: 'read'|'write'|'readwrite' }
 *
 * The real SQLite table name is derived from (dbUserId, name) so two
 * developers can both own a table called "notes" without colliding.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = (await req.json().catch(() => null)) as CreateBody | null
  if (!body || typeof body !== 'object') {
    return fail('Request body must be a JSON object.', 400)
  }

  try {
    const name = validateTableName(body.name)
    const columns = validateColumns(body.columns) as ColumnDef[]
    const accessMode = validateAccessMode(body.accessMode)

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

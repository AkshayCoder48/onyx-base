import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Virtual (read-only) tables exposed by the SQL Editor. Cannot be dropped. */
const SYSTEM_TABLES = [
  { name: 'users', type: 'virtual' },
  { name: 'records', type: 'virtual' },
  { name: 'collections', type: 'virtual' },
  { name: 'api_keys', type: 'virtual' },
  { name: 'logs', type: 'virtual' },
] as const

/** Whitelisted column types — uppercase only. */
const ALLOWED_TYPES = new Set([
  'TEXT',
  'INTEGER',
  'REAL',
  'NUMERIC',
  'BLOB',
  'DATETIME',
  'BOOLEAN',
])

/** Strict identifier regex (table names + column names). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Strict literal regex for DEFAULT values. */
const DEFAULT_RE =
  /^(?:'[^']*'|NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|-?\d+(?:\.\d+)?)$/i

// ─── Types ──────────────────────────────────────────────────────────────────

interface ColumnInput {
  name: string
  type: string
  primary?: boolean
  autoIncrement?: boolean
  nullable?: boolean
  defaultValue?: string
}

interface SqliteMasterRow {
  name: string
  sql: string | null
}

// ─── GET /api/dashboard/tables ──────────────────────────────────────────────
/**
 * Returns two lists:
 *   - systemTables: virtual read-only views (users, records, collections,
 *     api_keys, logs). Cannot be dropped.
 *   - userTables: every table in SQLite whose name starts with `usr_`,
 *     queried from sqlite_master.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  // Query sqlite_master for all user-created tables (usr_*).
  let userTables: { name: string; type: 'user'; sql: string }[] = []
  try {
    const rows = (await db.$queryRawUnsafe<SqliteMasterRow[]>(
      `SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'usr_%' ORDER BY name`,
    )) as SqliteMasterRow[]
    userTables = rows.map((r) => ({
      name: r.name,
      type: 'user' as const,
      sql: r.sql ?? '',
    }))
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to list tables: ${reason}`, 500)
  }

  return ok({
    systemTables: SYSTEM_TABLES.map((t) => ({ name: t.name, type: t.type })),
    userTables,
  })
}

// ─── POST /api/dashboard/tables ─────────────────────────────────────────────
/**
 * Create a new usr_* table from a structured column definition.
 *
 * DDL cannot be parameterised in SQLite, so every token is validated +
 * whitelisted before being interpolated into the final string:
 *   - table name: must start with usr_, match IDENT_RE, max 64 chars
 *   - column names: must match IDENT_RE
 *   - column types: must be in ALLOWED_TYPES
 *   - DEFAULT values: must match DEFAULT_RE (a literal-safe subset)
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== 'object') {
    return fail('Request body must be a JSON object.', 400)
  }

  const nameRaw = (body as { name?: unknown }).name
  const colsRaw = (body as { columns?: unknown }).columns

  if (typeof nameRaw !== 'string' || !nameRaw.trim()) {
    return fail('`name` (string) is required.', 400)
  }
  const name = nameRaw.trim()
  if (!name.toLowerCase().startsWith('usr_')) {
    return fail(
      'Custom tables must be prefixed with "usr_" (e.g. usr_notes).',
      400,
    )
  }
  if (name.length > 64) {
    return fail('Table name is too long (max 64 characters).', 400)
  }
  if (!IDENT_RE.test(name)) {
    return fail(
      'Table name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscores; must start with a letter or underscore).',
      400,
    )
  }

  if (!Array.isArray(colsRaw) || colsRaw.length === 0) {
    return fail('At least one column is required.', 400)
  }

  // Validate + normalise every column.
  const columns: ColumnInput[] = []
  for (let i = 0; i < colsRaw.length; i++) {
    const c = colsRaw[i] as Record<string, unknown>
    if (!c || typeof c !== 'object') {
      return fail(`Column ${i + 1} is not an object.`, 400)
    }
    const cname = c.name
    const ctype = c.type
    if (typeof cname !== 'string' || !IDENT_RE.test(cname)) {
      return fail(
        `Column ${i + 1}: name must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
        400,
      )
    }
    if (typeof ctype !== 'string') {
      return fail(`Column ${i + 1}: type is required.`, 400)
    }
    const typeUpper = ctype.toUpperCase()
    if (!ALLOWED_TYPES.has(typeUpper)) {
      return fail(
        `Column "${cname}": type "${ctype}" is not allowed. Use one of: ${[...ALLOWED_TYPES].join(', ')}.`,
        400,
      )
    }
    const col: ColumnInput = {
      name: cname,
      type: typeUpper,
      primary: c.primary === true,
      autoIncrement: c.autoIncrement === true,
      // Default to nullable=true (matching SQLite's behaviour) when `nullable`
      // is omitted. Only explicitly setting nullable:false marks NOT NULL.
      nullable: c.nullable !== false,
    }
    if (typeof c.defaultValue === 'string' && c.defaultValue.trim() !== '') {
      const dv = c.defaultValue.trim()
      if (!DEFAULT_RE.test(dv)) {
        return fail(
          `Column "${cname}": default value "${dv}" is not a safe literal. Allowed: NULL, CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME, a quoted string '...', or a number.`,
          400,
        )
      }
      col.defaultValue = dv
    }
    columns.push(col)
  }

  // Build the DDL — every token is whitelisted above, so this string concat
  // is safe.
  const colDefs: string[] = columns.map((c) => {
    const parts: string[] = [c.name, c.type]
    if (c.primary) {
      parts.push('PRIMARY', 'KEY')
      // AUTOINCREMENT is only valid on INTEGER PRIMARY KEY columns in SQLite.
      if (c.autoIncrement && c.type === 'INTEGER') {
        parts.push('AUTOINCREMENT')
      }
    }
    if (!c.nullable && !c.primary) {
      // PRIMARY KEY columns are implicitly NOT NULL.
      parts.push('NOT', 'NULL')
    }
    if (c.defaultValue) {
      parts.push('DEFAULT', c.defaultValue)
    }
    return parts.join(' ')
  })

  const ddl = `CREATE TABLE ${name} (\n  ${colDefs.join(',\n  ')}\n)`

  try {
    await db.$executeRawUnsafe(ddl)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`DDL error: ${reason}`, 400)
  }

  return ok({ table: { name, sql: ddl }, message: 'Table created' })
}

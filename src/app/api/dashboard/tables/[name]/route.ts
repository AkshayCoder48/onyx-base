import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

// ─── Constants ──────────────────────────────────────────────────────────────

/** Virtual (read-only) tables exposed by the SQL Editor. Cannot be dropped. */
const VIRTUAL_NAMES = new Set(['users', 'records', 'collections', 'api_keys', 'logs'])

/** Strict identifier regex (table names). */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// ─── Types ──────────────────────────────────────────────────────────────────

/** Recursively convert BigInt → Number / Buffer → string for JSON. */
function serializeRow(value: unknown): unknown {
  if (typeof value === 'bigint') return Number(value)
  if (Buffer.isBuffer(value)) return value.toString('utf8')
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(serializeRow)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeRow(v)
    }
    return out
  }
  return value
}

// ─── GET /api/dashboard/tables/[name] ───────────────────────────────────────
/**
 * Describe a table.
 *   - For usr_* tables: returns the PRAGMA table_info() column list and a
 *     sample of up to 100 rows. isVirtual=false.
 *   - For virtual table names: returns an empty result with isVirtual=true
 *     and a hint to use the SQL Editor.
 *
 * PRAGMA cannot be parameterised in SQLite — we validate `name` against the
 * IDENT_RE regex and interpolate it backtick-quoted.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { name } = await params
  const lc = name.toLowerCase()

  // Virtual table short-circuit.
  if (VIRTUAL_NAMES.has(lc)) {
    return ok({
      name: lc,
      columns: [],
      rowCount: 0,
      sampleRows: [],
      isVirtual: true,
      message: 'Virtual table — query via SQL Editor',
    })
  }

  // Validate the table name before interpolating into PRAGMA / SELECT.
  if (!lc.startsWith('usr_')) {
    return fail('Only usr_* custom tables can be inspected.', 400)
  }
  if (!IDENT_RE.test(name)) {
    return fail('Invalid table name.', 400)
  }

  try {
    // PRAGMA table_info(`<name>`) — name is validated against IDENT_RE.
    const pragmaRowsRaw = (await db.$queryRawUnsafe<unknown[]>(
      `PRAGMA table_info(\`${name}\`)`,
    )) as unknown[]

    if (pragmaRowsRaw.length === 0) {
      return fail(`Table "${name}" does not exist.`, 404)
    }

    const columns = pragmaRowsRaw.map((raw) => {
      const r = serializeRow(raw) as {
        cid?: number
        name?: string
        type?: string
        notnull?: number
        dflt_value?: string | null
        pk?: number
      }
      return {
        name: String(r.name ?? ''),
        type: String(r.type ?? ''),
        notnull: Number(r.notnull ?? 0) === 1,
        default: r.dflt_value ?? null,
        pk: Number(r.pk ?? 0),
      }
    })

    // Sample rows — also backtick-quoted (validated above).
    const sampleRowsRaw = (await db.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM \`${name}\` LIMIT 100`,
    )) as unknown[]

    const sampleRows = sampleRowsRaw.map((raw) =>
      serializeRow(raw) as Record<string, unknown>,
    )

    // Total row count (cheap on small tables; capped via COUNT(*)).
    let rowCount = sampleRows.length
    try {
      const countRowsRaw = (await db.$queryRawUnsafe<unknown[]>(
        `SELECT COUNT(*) as count FROM \`${name}\``,
      )) as unknown[]
      if (countRowsRaw.length > 0) {
        const cr = serializeRow(countRowsRaw[0]) as { count?: number }
        if (typeof cr.count === 'number') rowCount = cr.count
      }
    } catch {
      // Fall back to sampleRows.length if COUNT fails (shouldn't happen).
    }

    return ok({
      name,
      columns,
      rowCount,
      sampleRows,
      isVirtual: false,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to describe table: ${reason}`, 500)
  }
}

// ─── DELETE /api/dashboard/tables/[name] ────────────────────────────────────
/**
 * Drop a usr_* table. Refuses to drop virtual/system tables.
 * The `name` is validated against IDENT_RE before being interpolated into
 * the DROP statement.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const { name } = await params
  const lc = name.toLowerCase()

  if (VIRTUAL_NAMES.has(lc)) {
    return fail('Cannot drop a system table', 400)
  }

  if (!lc.startsWith('usr_')) {
    return fail('Only usr_* custom tables can be dropped.', 400)
  }
  if (!IDENT_RE.test(name)) {
    return fail('Invalid table name.', 400)
  }

  try {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${name}\``)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`Failed to drop table: ${reason}`, 400)
  }

  return ok({ message: 'Table dropped' })
}

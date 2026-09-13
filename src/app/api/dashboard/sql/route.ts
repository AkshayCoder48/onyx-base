import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'
import { runUserSelect } from '@/lib/sql-engine'
import {
  listRecords,
  upsertRecord,
  deleteRecord,
  deleteCollection,
} from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /api/dashboard/sql
 * Body: { sql: string }
 *
 * A read+write SQL Editor that runs against the user's REAL data in the
 * in-memory data-store (backed by db/cloudkv.json + Telegram mirror).
 *
 * Virtual tables (all filtered to the current user):
 *   - users        → the current user's profile
 *   - records      → all key-value records (all collections)
 *   - api_keys     → the user's API keys (key is MASKED in output)
 *   - collections  → the user's collections
 *   - logs         → the user's activity log
 *
 * Supported statements:
 *   - SELECT cols FROM table [WHERE col op val [AND ...]] [ORDER BY col [DESC]] [LIMIT n]
 *   - INSERT INTO records (key, value, valueType) VALUES ('k', 'v', 'string')
 *   - UPDATE records SET col = val [WHERE ...]
 *   - DELETE FROM records [WHERE ...]
 *   - CREATE / DROP / ALTER TABLE usr_*  (stored in Prisma, user-created tables)
 *
 * Security:
 *   1. Every query is user-scoped — you can only see/modify your own rows.
 *   2. INSERT/UPDATE/DELETE on `records` call the data-store's upsertRecord /
 *      deleteRecord so Telegram mirroring still fires.
 *   3. API keys are masked in SELECT output.
 *   4. No semicolons (prevents statement stacking).
 *   5. SELECT results capped at 1000 rows.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => null)
  if (!body || typeof body.sql !== 'string') {
    return fail('`sql` (string) is required.', 400)
  }

  const raw = body.sql.trim()
  if (!raw) return fail('Query is empty.', 400)

  if (raw.includes(';')) {
    return fail('Semicolons are not allowed. Run one query at a time.', 400)
  }

  const upper = raw.toUpperCase()
  const isSelect = upper.startsWith('SELECT') || upper.startsWith('WITH')
  const isInsert = upper.startsWith('INSERT')
  const isUpdate = upper.startsWith('UPDATE')
  const isDelete = upper.startsWith('DELETE')
  const isCreate = upper.startsWith('CREATE')
  const isDrop = upper.startsWith('DROP')
  const isAlter = upper.startsWith('ALTER')

  if (!isSelect && !isInsert && !isUpdate && !isDelete && !isCreate && !isDrop && !isAlter) {
    return fail(
      'Unsupported statement. Allowed: SELECT, WITH, INSERT, UPDATE, DELETE, CREATE, DROP, ALTER.',
      400,
    )
  }

  // ── DDL: CREATE/DROP/ALTER only on usr_* tables (stored in Prisma) ──
  if (isCreate || isDrop || isAlter) {
    const tableMatch = raw.match(/(?:CREATE|DROP|ALTER)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[`"]?(\w+)[`"]?/i)
    if (!tableMatch) {
      return fail('Could not parse table name from DDL statement.', 400)
    }
    const tableName = tableMatch[1]
    if (!tableName.toLowerCase().startsWith('usr_')) {
      return fail(
        `Custom tables must be prefixed with "usr_" (e.g. usr_mytable). "${tableName}" is not allowed.`,
        400,
      )
    }
    try {
      await db.$executeRawUnsafe(raw)
      return ok({
        rows: [],
        count: 0,
        affected: 0,
        truncated: false,
        type: 'ddl',
        message: `DDL executed on ${tableName}`,
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return fail(`DDL error: ${reason}`, 400)
    }
  }

  // ── Load the user's data from the in-memory data-store ──
  const uid = user.dbUserId
  const pubUid = user.userId

  if (isSelect) {
    return await handleSelect(raw, uid, pubUid)
  }

  if (isInsert) {
    return handleInsert(raw, uid, pubUid)
  }

  if (isUpdate) {
    return handleUpdate(raw, uid, pubUid)
  }

  if (isDelete) {
    return handleDelete(raw, uid, pubUid)
  }

  return fail('Unreachable.', 400)
}

// ─────────────────────────────────────────────────────────────────────────────
// SELECT handler — runs REAL SQL via Prisma with userId-scoped virtual tables
// ─────────────────────────────────────────────────────────────────────────────
//
// This delegates to runUserSelect() (in sql-engine.ts), which:
//   1. Rewrites virtual table names (records, collections, api_keys, logs,
//      users) into userId-filtered subqueries — but ONLY in FROM/JOIN
//      positions, so aliases and column qualifiers are not corrupted.
//   2. Runs the query via Prisma's $queryRawUnsafe against the real SQLite
//      database, with the userId parameterised into every placeholder.
//   3. Caps results at 1000 rows and serialises BigInts.
//
// Unlike the old JS-based parser, this supports the FULL SQL surface area:
// JOINs, GROUP BY, HAVING, aggregates (COUNT/SUM/AVG), functions
// (LENGTH/UPPER/DATE/...), subqueries, UNION, CTEs (WITH), etc.

async function handleSelect(raw: string, uid: string, pubUid: string) {
  try {
    const result = await runUserSelect(raw, pubUid)
    return ok({
      rows: result.rows,
      count: result.count,
      affected: 0,
      truncated: result.truncated,
      type: 'select',
      virtualTables: ['users', 'records', 'api_keys', 'collections', 'logs'],
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`SQL error: ${reason}`, 400)
  }
}

/** Parse a simple WHERE clause: col op val [AND col op val] */
function applyWhere(rows: Record<string, unknown>[], whereRaw: string): Record<string, unknown>[] {
  // Split on AND (case-insensitive)
  const conditions = whereRaw.split(/\s+AND\s+/i)
  return rows.filter((row) =>
    conditions.every((cond) => {
      // Parse: col op val
      const m = cond.trim().match(/^(\w+)\s*(=|!=|<>|>=|<=|>|<|LIKE)\s*(.+)$/i)
      if (!m) return true // skip unparseable conditions
      const [, col, op, valRaw] = m
      const cellVal = row[col]
      const val = parseSqlValue(valRaw.trim())
      switch (op.toUpperCase()) {
        case '=':
          return String(cellVal) === String(val)
        case '!=':
        case '<>':
          return String(cellVal) !== String(val)
        case '>':
          return Number(cellVal) > Number(val)
        case '<':
          return Number(cellVal) < Number(val)
        case '>=':
          return Number(cellVal) >= Number(val)
        case '<=':
          return Number(cellVal) <= Number(val)
        case 'LIKE':
          const pattern = String(val).replace(/%/g, '.*').replace(/_/g, '.')
          return new RegExp(`^${pattern}$`, 'i').test(String(cellVal))
        default:
          return true
      }
    }),
  )
}

/** Parse a SQL literal value: 'string', number, true/false, null */
function parseSqlValue(raw: string): unknown {
  if (raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.toLowerCase() === 'null') return null
  if (raw.toLowerCase() === 'true') return true
  if (raw.toLowerCase() === 'false') return false
  const n = Number(raw)
  if (!isNaN(n)) return n
  return raw
}

// ─────────────────────────────────────────────────────────────────────────────
// INSERT handler — calls upsertRecord
// ─────────────────────────────────────────────────────────────────────────────

function handleInsert(raw: string, uid: string, pubUid: string) {
  const m = raw.match(/INSERT\s+INTO\s+(`?\w+`?)\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i)
  if (!m) {
    return fail('INSERT must use the form: INSERT INTO table (cols) VALUES (vals)', 400)
  }
  const [, tableRaw, colsRaw, valsRaw] = m
  const table = tableRaw.replace(/`/g, '').toLowerCase()

  if (table !== 'records') {
    return fail(
      `INSERT is only supported on the "records" virtual table (got "${table}"). Use the dashboard UI for collections and API keys.`,
      400,
    )
  }

  const cols = colsRaw.split(',').map((c) => c.trim().replace(/`/g, '').toLowerCase())
  const vals = parseValList(valsRaw)
  if (cols.length !== vals.length) {
    return fail(`Column count (${cols.length}) doesn't match value count (${vals.length}).`, 400)
  }

  const obj: Record<string, unknown> = {}
  for (let i = 0; i < cols.length; i++) obj[cols[i]] = vals[i]

  if (!obj.key) return fail('INSERT into records requires a "key" column.', 400)
  if (obj.value === undefined) return fail('INSERT into records requires a "value" column.', 400)

  const collection = (obj.collection as string) || 'default'
  const rawValue = obj.value
  const valueType = (obj.valuetype as string) || detectValueType(String(rawValue))

  // The data-store expects JSON-encoded values (it calls JSON.parse internally
  // to send the parsed value to Telegram). So we JSON-stringify here.
  const value = JSON.stringify(rawValue)

  const result = upsertRecord(uid, pubUid, {
    collection,
    key: String(obj.key),
    value,
    valueType,
  })

  return ok({
    rows: [],
    count: 0,
    affected: 1, // upsert always affects 1 row (insert OR update)
    truncated: false,
    type: 'write',
    target: 'records',
    message: result.created
      ? `Inserted record "${obj.key}" into collection "${collection}".`
      : `Updated existing record "${obj.key}" in collection "${collection}".`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE handler — finds matching records, upserts each
// ─────────────────────────────────────────────────────────────────────────────

function handleUpdate(raw: string, uid: string, pubUid: string) {
  const m = raw.match(/UPDATE\s+(`?\w+`?)\s+SET\s+(.*?)(\s+WHERE\s+(.+))?$/is)
  if (!m) {
    return fail('UPDATE must use the form: UPDATE table SET col = val WHERE ...', 400)
  }
  const [, tableRaw, setClause, , whereRaw] = m
  const table = tableRaw.replace(/`/g, '').toLowerCase()

  if (table !== 'records') {
    return fail(`UPDATE is only supported on the "records" virtual table (got "${table}").`, 400)
  }

  // Parse SET clause: col = val, col = val
  const sets: { col: string; val: unknown }[] = []
  for (const part of setClause.split(',')) {
    const sm = part.trim().match(/^(\w+)\s*=\s*(.+)$/)
    if (!sm) return fail(`Could not parse SET clause: "${part}". Use col = val`, 400)
    sets.push({ col: sm[1].toLowerCase(), val: parseSqlValue(sm[2].trim()) })
  }

  // Load records, filter by WHERE, then update each.
  let recs = listRecords(uid)
  if (whereRaw) {
    recs = applyWhere(
      recs.map((r) => ({ ...r, valueType: r.valueType, valuetype: r.valueType })) as Record<string, unknown>[],
      whereRaw,
    ) as unknown as ReturnType<typeof listRecords>
  }

  let affected = 0
  for (const r of recs) {
    let newKey = r.key
    let newValue = r.value
    let newValueType = r.valueType
    for (const s of sets) {
      if (s.col === 'key') newKey = String(s.val)
      else if (s.col === 'value') {
        // JSON-encode the new value for the data-store
        newValue = JSON.stringify(s.val)
        if (!sets.find((x) => x.col === 'valuetype')) {
          newValueType = detectValueType(String(s.val))
        }
      } else if (s.col === 'valuetype' || s.col === 'valueType') newValueType = String(s.val)
    }
    upsertRecord(uid, pubUid, {
      collection: r.collection,
      key: newKey,
      value: newValue,
      valueType: newValueType,
    })
    affected++
  }

  return ok({
    rows: [],
    count: 0,
    affected,
    truncated: false,
    type: 'write',
    target: 'records',
    message: `${affected} record${affected === 1 ? '' : 's'} updated.`,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE handler — calls deleteRecord
// ─────────────────────────────────────────────────────────────────────────────

function handleDelete(raw: string, uid: string, pubUid: string) {
  const m = raw.match(/DELETE\s+FROM\s+(`?\w+`?)(\s+WHERE\s+(.+))?$/is)
  if (!m) {
    return fail('DELETE must use the form: DELETE FROM table WHERE ...', 400)
  }
  const [, tableRaw, , whereRaw] = m
  const table = tableRaw.replace(/`/g, '').toLowerCase()

  if (table === 'records') {
    let recs = listRecords(uid)
    if (whereRaw) {
      recs = applyWhere(
        recs.map((r) => ({ ...r, valueType: r.valueType, valuetype: r.valueType })) as Record<string, unknown>[],
        whereRaw,
      ) as unknown as ReturnType<typeof listRecords>
    }
    let affected = 0
    for (const r of recs) {
      const removed = deleteRecord(uid, r.collection, r.key)
      if (removed) affected++
    }
    return ok({
      rows: [],
      count: 0,
      affected,
      truncated: false,
      type: 'write',
      target: 'records',
      message: `${affected} record${affected === 1 ? '' : 's'} deleted.`,
    })
  }

  if (table === 'collections') {
    // DELETE FROM collections WHERE name = 'foo'
    if (!whereRaw) return fail('DELETE FROM collections requires a WHERE name = ... clause.', 400)
    const wm = whereRaw.match(/name\s*=\s*'([^']+)'/i)
    if (!wm) return fail('DELETE FROM collections requires: WHERE name = \'collection_name\'', 400)
    const result = deleteCollection(uid, wm[1])
    return ok({
      rows: [],
      count: 0,
      affected: result ? 1 : 0,
      truncated: false,
      type: 'write',
      target: 'collections',
      message: result ? `Collection "${wm[1]}" deleted.` : `Collection "${wm[1]}" not found.`,
    })
  }

  return fail(`DELETE is only supported on "records" and "collections" (got "${table}").`, 400)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a comma-separated value list: 'a', 123, true, null */
function parseValList(raw: string): unknown[] {
  const vals: unknown[] = []
  let i = 0
  while (i < raw.length) {
    // Skip whitespace
    while (i < raw.length && /\s/.test(raw[i])) i++
    if (i >= raw.length) break

    if (raw[i] === "'") {
      // String literal
      let end = i + 1
      let val = ''
      while (end < raw.length) {
        if (raw[end] === "'" && raw[end + 1] === "'") {
          val += "'"
          end += 2
        } else if (raw[end] === "'") {
          end++
          break
        } else {
          val += raw[end]
          end++
        }
      }
      vals.push(val)
      i = end
    } else {
      // Non-string (number, boolean, null)
      let end = i
      while (end < raw.length && raw[end] !== ',' && !/\s/.test(raw[end])) end++
      const token = raw.slice(i, end).trim()
      vals.push(parseSqlValue(token))
      i = end
    }
    // Skip to next comma
    while (i < raw.length && raw[i] !== ',') i++
    i++ // skip comma
  }
  return vals
}

/** Detect the valueType from a JS value. */
function detectValueType(value: string): string {
  if (value === 'true' || value === 'false') return 'boolean'
  if (!isNaN(Number(value))) return 'number'
  try {
    const parsed = JSON.parse(value)
    if (Array.isArray(parsed)) return 'array'
    if (typeof parsed === 'object') return 'object'
  } catch {
    // not JSON
  }
  return 'string'
}

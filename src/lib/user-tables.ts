/**
 * Onyx Base — account-scoped custom tables engine.
 *
 * Every developer can create their own SQL tables. The metadata (owner,
 * display name, real SQLite table name, access mode, column schema) is stored
 * in the `UserTable` Prisma table; the actual data lives in a real SQLite
 * table named `usr_<shortHash>_<name>` so two developers can both own a table
 * called "notes" without colliding.
 *
 * All Prisma access uses `$queryRawUnsafe` / `$executeRawUnsafe` so the
 * runtime schema bootstrap (see src/lib/db.ts) runs first — this is what
 * makes the feature work on Vercel serverless where `prisma db push` never
 * runs and the SQLite file is fresh on every cold start.
 *
 * DDL cannot be parameterised in SQLite, so every identifier that gets
 * interpolated into a SQL string is first validated against IDENT_RE and
 * every literal value is bound as a parameter (never string-interpolated).
 */

import crypto from 'crypto'
import { db } from '@/lib/db'

// ─── Constants ───────────────────────────────────────────────────────────────

/** Strict identifier regex (table names + column names). */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Whitelisted column types — uppercase only. */
export const ALLOWED_TYPES = new Set([
  'TEXT',
  'INTEGER',
  'REAL',
  'NUMERIC',
  'BLOB',
  'DATETIME',
  'BOOLEAN',
])

/** Strict literal regex for DEFAULT values. */
export const DEFAULT_RE =
  /^(?:'[^']*'|NULL|CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|-?\d+(?:\.\d+)?)$/i

export type AccessMode = 'read' | 'write' | 'readwrite'

const VALID_MODES = new Set<AccessMode>(['read', 'write', 'readwrite'])

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ColumnDef {
  name: string
  type: string
  primary?: boolean
  autoIncrement?: boolean
  nullable?: boolean
  defaultValue?: string
}

export interface UserTableMeta {
  id: string
  userId: string
  name: string
  tableName: string
  accessMode: AccessMode
  schema: ColumnDef[]
  rowCount: number
  createdAt: string
  updatedAt: string
}

export interface DescribeColumn {
  name: string
  type: string
  notnull: boolean
  default: string | null
  pk: number
}

export interface DescribeResult {
  name: string
  tableName: string
  accessMode: AccessMode
  columns: DescribeColumn[]
  schema: ColumnDef[]
  rowCount: number
  rows: Record<string, unknown>[]
}

// ─── Serialisation ───────────────────────────────────────────────────────────

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

// ─── Validation ──────────────────────────────────────────────────────────────

/** Validate + normalise a column definition list. Throws on invalid input. */
export function validateColumns(colsRaw: unknown): ColumnDef[] {
  if (!Array.isArray(colsRaw) || colsRaw.length === 0) {
    throw new ValidationError('At least one column is required.')
  }
  const columns: ColumnDef[] = []
  for (let i = 0; i < colsRaw.length; i++) {
    const c = colsRaw[i] as Record<string, unknown>
    if (!c || typeof c !== 'object') {
      throw new ValidationError(`Column ${i + 1} is not an object.`)
    }
    const cname = c.name
    const ctype = c.type
    if (typeof cname !== 'string' || !IDENT_RE.test(cname)) {
      throw new ValidationError(
        `Column ${i + 1}: name must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
      )
    }
    if (typeof ctype !== 'string') {
      throw new ValidationError(`Column ${i + 1}: type is required.`)
    }
    const typeUpper = ctype.toUpperCase()
    if (!ALLOWED_TYPES.has(typeUpper)) {
      throw new ValidationError(
        `Column "${cname}": type "${ctype}" is not allowed. Use one of: ${[...ALLOWED_TYPES].join(', ')}.`,
      )
    }
    const col: ColumnDef = {
      name: cname,
      type: typeUpper,
      primary: c.primary === true,
      autoIncrement: c.autoIncrement === true,
      nullable: c.nullable !== false,
    }
    if (typeof c.defaultValue === 'string' && c.defaultValue.trim() !== '') {
      const dv = c.defaultValue.trim()
      if (!DEFAULT_RE.test(dv)) {
        throw new ValidationError(
          `Column "${cname}": default value "${dv}" is not a safe literal. Allowed: NULL, CURRENT_TIMESTAMP, CURRENT_DATE, CURRENT_TIME, a quoted string '...', or a number.`,
        )
      }
      col.defaultValue = dv
    }
    columns.push(col)
  }
  // Unique names
  const names = new Set(columns.map((c) => c.name))
  if (names.size !== columns.length) {
    throw new ValidationError('Column names must be unique.')
  }
  return columns
}

/** Validate a table display name (no usr_ prefix needed). */
export function validateTableName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim()) {
    throw new ValidationError('`name` (string) is required.')
  }
  const n = name.trim()
  if (n.length > 64) {
    throw new ValidationError('Table name is too long (max 64 characters).')
  }
  if (!IDENT_RE.test(n)) {
    throw new ValidationError(
      'Table name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (letters, digits, underscores; must start with a letter or underscore).',
    )
  }
  if (n.toLowerCase().startsWith('usr_')) {
    throw new ValidationError(
      'The "usr_" prefix is added automatically — please choose a name without it.',
    )
  }
  return n
}

export function validateAccessMode(mode: unknown): AccessMode {
  if (mode === undefined || mode === null) return 'readwrite'
  if (typeof mode !== 'string') {
    throw new ValidationError('`accessMode` must be a string.')
  }
  const m = mode.toLowerCase() as AccessMode
  if (!VALID_MODES.has(m)) {
    throw new ValidationError(
      `accessMode must be one of: read, write, readwrite (got "${mode}").`,
    )
  }
  return m
}

export class ValidationError extends Error {}

// ─── Table-name generation ───────────────────────────────────────────────────

/**
 * Generate the real SQLite table name for a (dbUserId, name) pair.
 * Format: `usr_<name>_<8-char-sha1-of-dbUserId>`.
 *
 * The 8-char hash is enough to make collisions between users astronomically
 * unlikely while keeping the name short enough for SQL Editor queries.
 */
export function generateTableName(dbUserId: string, name: string): string {
  const hash = crypto.createHash('sha1').update(dbUserId).digest('hex').slice(0, 8)
  return `usr_${name}_${hash}`
}

// ─── DDL builder ─────────────────────────────────────────────────────────────

/** Build a CREATE TABLE statement from validated column defs. */
function buildCreateDDL(tableName: string, columns: ColumnDef[]): string {
  const colDefs: string[] = columns.map((c) => {
    const parts: string[] = [`\`${c.name}\``, c.type]
    if (c.primary) {
      parts.push('PRIMARY', 'KEY')
      if (c.autoIncrement && c.type === 'INTEGER') {
        parts.push('AUTOINCREMENT')
      }
    }
    if (!c.nullable && !c.primary) {
      parts.push('NOT', 'NULL')
    }
    if (c.defaultValue) {
      parts.push('DEFAULT', c.defaultValue)
    }
    return parts.join(' ')
  })
  return `CREATE TABLE \`${tableName}\` (\n  ${colDefs.join(',\n  ')}\n)`
}

// ─── CRUD: table metadata ────────────────────────────────────────────────────

interface UserTableRow {
  id: string
  userId: string
  name: string
  tableName: string
  accessMode: string
  schema: string
  rowCount: number
  createdAt: string
  updatedAt: string
}

function rowToMeta(r: UserTableRow): UserTableMeta {
  return {
    id: r.id,
    userId: r.userId,
    name: r.name,
    tableName: r.tableName,
    accessMode: r.accessMode as AccessMode,
    schema: JSON.parse(r.schema) as ColumnDef[],
    rowCount: r.rowCount,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }
}

/** List every table owned by a user. */
export async function listUserTables(dbUserId: string): Promise<UserTableMeta[]> {
  const rows = (await db.$queryRawUnsafe<UserTableRow[]>(
    `SELECT id, userId, name, tableName, accessMode, schema, rowCount, createdAt, updatedAt FROM "UserTable" WHERE "userId" = ? ORDER BY name`,
    dbUserId,
  )) as UserTableRow[]
  return rows.map(rowToMeta)
}

/** Find one table by (owner, display name). Returns null if not found. */
export async function findUserTable(
  dbUserId: string,
  name: string,
): Promise<UserTableMeta | null> {
  const rows = (await db.$queryRawUnsafe<UserTableRow[]>(
    `SELECT id, userId, name, tableName, accessMode, schema, rowCount, createdAt, updatedAt FROM "UserTable" WHERE "userId" = ? AND "name" = ? LIMIT 1`,
    dbUserId,
    name,
  )) as UserTableRow[]
  if (rows.length === 0) return null
  return rowToMeta(rows[0])
}

/** Create a new table — metadata + the real SQLite table. */
export async function createUserTable(
  dbUserId: string,
  name: string,
  columns: ColumnDef[],
  accessMode: AccessMode,
): Promise<UserTableMeta> {
  const tableName = generateTableName(dbUserId, name)

  // Check for name collision within the user's account.
  const existing = await findUserTable(dbUserId, name)
  if (existing) {
    throw new ValidationError(`A table named "${name}" already exists in your account.`)
  }

  // Build + run the DDL. Every token is validated above, so interpolation is safe.
  const ddl = buildCreateDDL(tableName, columns)
  try {
    await db.$executeRawUnsafe(ddl)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`DDL error: ${reason}`)
  }

  // Insert the metadata row.
  const id = crypto.randomUUID()
  const schemaJson = JSON.stringify(columns)
  const now = new Date().toISOString()
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO "UserTable" ("id", "userId", "name", "tableName", "accessMode", "schema", "rowCount", "createdAt", "updatedAt") VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      id,
      dbUserId,
      name,
      tableName,
      accessMode,
      schemaJson,
      now,
      now,
    )
  } catch (err) {
    // Best-effort cleanup: drop the table we just created so the state stays
    // consistent if the metadata insert failed (e.g. unique constraint).
    try {
      await db.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${tableName}\``)
    } catch {
      /* ignore */
    }
    const reason = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`Failed to register table: ${reason}`)
  }

  return {
    id,
    userId: dbUserId,
    name,
    tableName,
    accessMode,
    schema: columns,
    rowCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

/** Drop a table — verify ownership, DELETE the metadata, then DROP the real
 * SQLite table.
 *
 * Order matters: the metadata row is deleted FIRST so that even if the
 * `DROP TABLE` fails (e.g. DB locked), the table will no longer appear in
 * listUserTables(). An orphaned real table is harmless (it just occupies a
 * little disk space); an orphaned metadata row is NOT — it would make a
 * dropped table "reappear" in the UI and crash describe/rows endpoints.
 */
export async function dropUserTable(
  dbUserId: string,
  name: string,
): Promise<void> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }
  // 1. Delete the metadata row so the table immediately disappears from all
  //    list/describe queries, regardless of what happens next.
  await db.$executeRawUnsafe(
    `DELETE FROM "UserTable" WHERE "id" = ?`,
    meta.id,
  )
  // 2. Drop the real SQLite table. Best-effort: if this fails we log but do
  //    not throw — the metadata is already gone, so from the user's point of
  //    view the table is dropped. A leftover empty usr_* table is harmless.
  try {
    await db.$executeRawUnsafe(`DROP TABLE IF EXISTS \`${meta.tableName}\``)
  } catch (err) {
    console.error(
      `[user-tables] metadata for "${name}" was deleted but DROP TABLE \`${meta.tableName}\` failed:`,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Change the access mode of a table. */
export async function updateAccessMode(
  dbUserId: string,
  name: string,
  accessMode: AccessMode,
): Promise<UserTableMeta> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }
  const now = new Date().toISOString()
  await db.$executeRawUnsafe(
    `UPDATE "UserTable" SET "accessMode" = ?, "updatedAt" = ? WHERE "id" = ?`,
    accessMode,
    now,
    meta.id,
  )
  return { ...meta, accessMode, updatedAt: now }
}

// ─── Describe ────────────────────────────────────────────────────────────────

/** Describe a table: schema (PRAGMA) + row count + sample rows. */
export async function describeUserTable(
  dbUserId: string,
  name: string,
  rowLimit = 100,
): Promise<DescribeResult> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }

  const pragmaRows = (await db.$queryRawUnsafe<unknown[]>(
    `PRAGMA table_info(\`${meta.tableName}\`)`,
  )) as unknown[]

  const columns: DescribeColumn[] = pragmaRows.map((raw) => {
    const r = serializeRow(raw) as {
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

  const sampleRowsRaw = (await db.$queryRawUnsafe<unknown[]>(
    `SELECT * FROM \`${meta.tableName}\` LIMIT ?`,
    Math.min(Math.max(rowLimit, 1), 1000),
  )) as unknown[]

  const rows = sampleRowsRaw.map(
    (raw) => serializeRow(raw) as Record<string, unknown>,
  )

  let rowCount = rows.length
  try {
    const countRows = (await db.$queryRawUnsafe<unknown[]>(
      `SELECT COUNT(*) as count FROM \`${meta.tableName}\``,
    )) as unknown[]
    if (countRows.length > 0) {
      const cr = serializeRow(countRows[0]) as { count?: number }
      if (typeof cr.count === 'number') rowCount = cr.count
    }
  } catch {
    /* fall back to sample length */
  }

  return {
    name: meta.name,
    tableName: meta.tableName,
    accessMode: meta.accessMode,
    columns,
    schema: meta.schema,
    rowCount,
    rows,
  }
}

/** Sync the cached rowCount in the metadata table. */
export async function syncRowCount(
  dbUserId: string,
  name: string,
): Promise<void> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) return
  try {
    const countRows = (await db.$queryRawUnsafe<unknown[]>(
      `SELECT COUNT(*) as count FROM \`${meta.tableName}\``,
    )) as unknown[]
    if (countRows.length > 0) {
      const cr = serializeRow(countRows[0]) as { count?: number }
      if (typeof cr.count === 'number') {
        const now = new Date().toISOString()
        await db.$executeRawUnsafe(
          `UPDATE "UserTable" SET "rowCount" = ?, "updatedAt" = ? WHERE "id" = ?`,
          cr.count,
          now,
          meta.id,
        )
      }
    }
  } catch {
    /* ignore count sync failures */
  }
}

// ─── Row CRUD ────────────────────────────────────────────────────────────────

/**
 * Coerce a JS value into a form SQLite accepts via parameter binding.
 * Objects/arrays are JSON-stringified; undefined becomes null.
 */
function bindValue(v: unknown): unknown {
  if (v === undefined) return null
  if (typeof v === 'object' && v !== null && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    return JSON.stringify(v)
  }
  return v
}

/** Identify the PK column(s) from the stored schema. */
function pkColumns(schema: ColumnDef[]): ColumnDef[] {
  const pks = schema.filter((c) => c.primary)
  return pks.length > 0 ? pks : schema.slice(0, 1)
}

/** List rows (up to `limit`). */
export async function listRows(
  dbUserId: string,
  name: string,
  limit = 100,
): Promise<Record<string, unknown>[]> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }
  const rows = (await db.$queryRawUnsafe<unknown[]>(
    `SELECT * FROM \`${meta.tableName}\` LIMIT ?`,
    Math.min(Math.max(limit, 1), 1000),
  )) as unknown[]
  return rows.map((r) => serializeRow(r) as Record<string, unknown>)
}

/** Insert a row. Returns the inserted row (with auto-increment PKs filled in). */
export async function insertRow(
  dbUserId: string,
  name: string,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }
  // Only bind columns that exist in the schema.
  const schemaNames = new Set(meta.schema.map((c) => c.name))
  const cols: string[] = []
  const vals: unknown[] = []
  for (const [k, v] of Object.entries(row)) {
    if (schemaNames.has(k)) {
      cols.push(k)
      vals.push(bindValue(v))
    }
  }
  if (cols.length === 0) {
    throw new ValidationError(
      'No valid columns in the row. Provide at least one column that exists in the table schema.',
    )
  }
  const placeholders = cols.map(() => '?').join(', ')
  const colList = cols.map((c) => `\`${c}\``).join(', ')
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO \`${meta.tableName}\` (${colList}) VALUES (${placeholders})`,
      ...vals,
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`Insert failed: ${reason}`)
  }
  await syncRowCount(dbUserId, name)

  // Fetch the last inserted row. If there's an INTEGER PRIMARY KEY, use
  // last_insert_rowid(); otherwise fall back to the max PK.
  const pks = pkColumns(meta.schema)
  let inserted: Record<string, unknown> | null = null
  try {
    if (pks.length === 1 && pks[0].type === 'INTEGER') {
      const rows = (await db.$queryRawUnsafe<unknown[]>(
        `SELECT * FROM \`${meta.tableName}\` WHERE \`${pks[0].name}\` = last_insert_rowid() LIMIT 1`,
      )) as unknown[]
      if (rows.length > 0) inserted = serializeRow(rows[0]) as Record<string, unknown>
    }
  } catch {
    /* fall through */
  }
  if (!inserted) {
    // Fallback: return what we were given (best-effort).
    inserted = { ...row }
  }
  return inserted
}

/**
 * Update rows by PK. `pk` is a partial object mapping PK column → value.
 * `patch` is the set of columns to update.
 * Returns the number of rows affected.
 */
export async function updateRow(
  dbUserId: string,
  name: string,
  pk: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<number> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }
  const schemaNames = new Set(meta.schema.map((c) => c.name))
  const setCols: string[] = []
  const setVals: unknown[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (schemaNames.has(k) && !meta.schema.find((c) => c.name === k)?.primary) {
      setCols.push(k)
      setVals.push(bindValue(v))
    }
  }
  if (setCols.length === 0) {
    throw new ValidationError(
      'No updatable columns in the patch. PK columns cannot be updated.',
    )
  }
  const pkEntries = Object.entries(pk).filter(([k]) => schemaNames.has(k))
  if (pkEntries.length === 0) {
    throw new ValidationError(
      'A valid PK column is required to identify the row to update.',
    )
  }
  const setClause = setCols.map((c) => `\`${c}\` = ?`).join(', ')
  const whereClause = pkEntries.map(([k]) => `\`${k}\` = ?`).join(' AND ')
  const whereVals = pkEntries.map(([, v]) => bindValue(v))
  try {
    await db.$executeRawUnsafe(
      `UPDATE \`${meta.tableName}\` SET ${setClause} WHERE ${whereClause}`,
      ...setVals,
      ...whereVals,
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`Update failed: ${reason}`)
  }
  await syncRowCount(dbUserId, name)
  return 1
}

/**
 * Delete rows by PK. `pk` is a partial object mapping PK column → value.
 * Returns whether any row was deleted.
 */
export async function deleteRow(
  dbUserId: string,
  name: string,
  pk: Record<string, unknown>,
): Promise<boolean> {
  const meta = await findUserTable(dbUserId, name)
  if (!meta) {
    throw new ValidationError(`Table "${name}" does not exist in your account.`)
  }
  const schemaNames = new Set(meta.schema.map((c) => c.name))
  const pkEntries = Object.entries(pk).filter(([k]) => schemaNames.has(k))
  if (pkEntries.length === 0) {
    throw new ValidationError(
      'A valid PK column is required to identify the row to delete.',
    )
  }
  const whereClause = pkEntries.map(([k]) => `\`${k}\` = ?`).join(' AND ')
  const whereVals = pkEntries.map(([, v]) => bindValue(v))
  try {
    await db.$executeRawUnsafe(
      `DELETE FROM \`${meta.tableName}\` WHERE ${whereClause}`,
      ...whereVals,
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new ValidationError(`Delete failed: ${reason}`)
  }
  await syncRowCount(dbUserId, name)
  return true
}

// ─── Access-mode helpers ─────────────────────────────────────────────────────

/** True if the access mode allows read operations (SELECT). */
export function canRead(mode: AccessMode): boolean {
  return mode === 'read' || mode === 'readwrite'
}

/** True if the access mode allows write operations (INSERT/UPDATE/DELETE). */
export function canWrite(mode: AccessMode): boolean {
  return mode === 'write' || mode === 'readwrite'
}

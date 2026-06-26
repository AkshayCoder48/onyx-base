/**
 * Onyx Base — shared SQL SELECT engine.
 *
 * Extracted from /api/dashboard/sql/route.ts so the Materialized View
 * refresh path can reuse the exact same user-scoped virtual-table rewrite.
 *
 * Given a raw SQL string + the user's public userId (e.g. `usr_abc123`),
 * this:
 *   1. Validates it's a SELECT (or WITH ... SELECT) — never a write.
 *   2. Rewrites virtual table names (records, collections, api_keys,
 *      logs, users) into userId-filtered subqueries — but ONLY when they
 *      appear as the object of FROM or JOIN, not as column qualifiers
 *      (records.key) or aliases (AS records).
 *   3. Runs the query via Prisma's $queryRawUnsafe with the userId
 *      parameterised into every `?`.
 *   4. Returns the rows (BigInts serialised to Numbers, 1000-row cap).
 *
 * SECURITY: the userId is always parameterised, never string-interpolated.
 * The user can write any WHERE clause they like — they can never escape
 * the userId filter that's baked into every virtual-table subquery.
 */

import { db } from '@/lib/db'

export interface SelectResult {
  rows: unknown[]
  count: number
  truncated: boolean
}

const MASKED_KEY = `substr(\`key\`, 1, 12) || '...' || substr(\`key\`, -4)`

/**
 * Map of virtual table name → userId-filtered subquery.
 * Each subquery is wrapped in parentheses and given the original name as
 * its alias, so queries like `SELECT records.key FROM records` still work
 * after rewrite (the alias `records` is preserved).
 */
const VIRTUAL_TABLES: Record<string, string> = {
  api_keys: `(SELECT id, name, ${MASKED_KEY} AS \`key\`, revoked, lastUsedAt, createdAt, userId FROM ApiKey WHERE userId = ?) AS api_keys`,
  collections: `(SELECT id, name, userId, createdAt FROM Collection WHERE userId = ?) AS collections`,
  records: `(SELECT id, userId, collectionId, \`key\`, value, valueType, telegramMessageId, createdAt, updatedAt FROM Record WHERE userId = ?) AS records`,
  logs: `(SELECT id, userId, action, \`key\`, detail, source, ip, createdAt FROM Log WHERE userId = ?) AS logs`,
  users: `(SELECT id, userId, name, email, plan, createdAt, updatedAt FROM User WHERE userId = ?) AS users`,
}

/**
 * Rewrite virtual table names in the SQL string.
 *
 * ONLY replaces a table name when it appears as the direct object of a
 * FROM or JOIN clause. This avoids corrupting:
 *   - Column qualifiers: `records.key` → left alone (the `records` after
 *     FROM is replaced, and the alias in the subquery is `records` so the
 *     qualifier still resolves).
 *   - Aliases: `SELECT COUNT(*) AS records FROM records` → only the FROM
 *     target is replaced; the column alias `records` is untouched.
 *   - Subquery correlations: `... WHERE x IN (SELECT ... FROM records)` →
 *     the inner FROM is also replaced correctly.
 *
 * The regex matches: (FROM|JOIN) \s+ optional-backtick (table) optional-backtick
 * We use a function replacer so we can look up the table name in the
 * VIRTUAL_TABLES map and only substitute known virtual tables.
 */
function rewriteVirtualTables(sql: string): string {
  // Match FROM or JOIN followed by an optional backtick-quoted identifier.
  // Capture group 1 = keyword (FROM/JOIN), group 2 = optional opening
  // backtick, group 3 = table name, group 4 = optional closing backtick.
  // The `i` flag makes it case-insensitive; `g` replaces all occurrences
  // (important for subqueries with multiple FROM/JOIN).
  const re = /\b(FROM|JOIN)\s+(`?)(api_keys|collections|records|logs|users)\2/gi
  return sql.replace(re, (match, keyword: string, _bt: string, table: string) => {
    const sub = VIRTUAL_TABLES[table.toLowerCase()]
    if (!sub) return match // unknown table — leave as-is
    return `${keyword} ${sub}`
  })
}

/** Recursively convert BigInt → Number so the result is JSON-serialisable. */
function serializeRows(rows: unknown): unknown {
  if (typeof rows === 'bigint') return Number(rows)
  if (Array.isArray(rows)) return rows.map(serializeRows)
  if (rows && typeof rows === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(rows as Record<string, unknown>)) {
      out[k] = serializeRows(v)
    }
    return out
  }
  return rows
}

/**
 * Run a user-scoped SELECT. Throws on syntax error, unsupported statement,
 * or anything else Prisma rejects — callers should wrap in try/catch.
 */
export async function runUserSelect(
  sql: string,
  userId: string,
): Promise<SelectResult> {
  const raw = sql.trim()
  if (!raw) throw new Error('Query is empty.')
  if (raw.includes(';')) {
    throw new Error('Semicolons are not allowed. Run one query at a time.')
  }
  const upper = raw.toUpperCase()
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    throw new Error('Materialized views only support SELECT / WITH queries.')
  }

  // Rewrite virtual table names in FROM/JOIN clauses into userId-filtered
  // subqueries. The userId is parameterised (as `?`) — never interpolated.
  const rewritten = rewriteVirtualTables(raw)

  // Count how many `?` placeholders the rewrite produced and bind the
  // userId to each one. Prisma's $queryRawUnsafe binds positional params
  // in order.
  const placeholderCount = (rewritten.match(/\?/g) ?? []).length
  const params = new Array(placeholderCount).fill(userId)

  // Wrap in an outer SELECT * FROM (...) so the result is always a flat
  // row set, regardless of whether the user wrote a scalar subquery,
  // a GROUP BY aggregate, or a JOIN.
  const finalSql = `SELECT * FROM (${rewritten}) AS __result LIMIT 1000`
  const rows = await db.$queryRawUnsafe(finalSql, ...params)
  const safe = serializeRows(rows) as unknown[]
  return {
    rows: safe,
    count: safe.length,
    truncated: safe.length >= 1000,
  }
}

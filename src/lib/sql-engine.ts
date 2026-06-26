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
 *      logs, users) into userId-filtered subqueries.
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

const SELECT_REPLACEMENTS: [RegExp, string][] = [
  [
    /\bapi_keys\b/g,
    `(SELECT id, name, ${MASKED_KEY} AS \`key\`, revoked, lastUsedAt, createdAt, userId FROM ApiKey WHERE userId = ?) AS api_keys`,
  ],
  [
    /\bcollections\b/g,
    `(SELECT id, name, userId, createdAt FROM Collection WHERE userId = ?) AS collections`,
  ],
  [
    /\brecords\b/g,
    `(SELECT id, userId, collectionId, \`key\`, value, valueType, telegramMessageId, createdAt, updatedAt FROM Record WHERE userId = ?) AS records`,
  ],
  [
    /\blogs\b/g,
    `(SELECT id, userId, action, \`key\`, detail, source, ip, createdAt FROM Log WHERE userId = ?) AS logs`,
  ],
  [
    /\busers\b/g,
    `(SELECT id, userId, name, email, plan, createdAt, updatedAt FROM User WHERE userId = ?) AS users`,
  ],
]

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

  let rewritten = raw
  for (const [pattern, sub] of SELECT_REPLACEMENTS) {
    rewritten = rewritten.replace(pattern, sub)
  }
  const placeholderCount = (rewritten.match(/\?/g) ?? []).length
  const params = new Array(placeholderCount).fill(userId)

  const finalSql = `SELECT * FROM (${rewritten}) AS __result LIMIT 1000`
  const rows = await db.$queryRawUnsafe(finalSql, ...params)
  const safe = serializeRows(rows) as unknown[]
  return {
    rows: safe,
    count: safe.length,
    truncated: safe.length >= 1000,
  }
}

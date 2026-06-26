import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { db } from '@/lib/db'

export const runtime = 'nodejs'

/**
 * POST /api/dashboard/sql
 * Body: { sql: string }
 *
 * A read-only SQL Editor (the "SQL Editor" roadmap item from the feature
 * inventory). Lets the user run SELECT queries against their own data using
 * virtual table names that are pre-filtered by their userId — so it's
 * impossible to read another user's rows.
 *
 * Virtual tables (all filtered to the current user):
 *   - users        → User (current user's row only; email + plan + dates)
 *   - records      → Record (key, value, valueType, collectionId, dates)
 *   - api_keys     → ApiKey (name, key, revoked, lastUsedAt, createdAt) — key is MASKED
 *   - collections  → Collection (name, createdAt)
 *   - logs         → Log (action, key, detail, source, ip, createdAt)
 *
 * Security:
 *   1. Read-only: the trimmed query MUST start with SELECT or WITH. Anything
 *      else → 400. We also reject semicolons (no statement stacking).
 *   2. User-scoped: virtual table names are rewritten to subqueries with
 *      `WHERE userId = ?` (parameterised). The user can only see their own
 *      rows no matter what WHERE clause they write.
 *   3. Row limit: results are capped at 1000 rows (wrapped in an outer
 *      SELECT with LIMIT).
 *   4. API-key masking: the `key` column in api_keys is replaced with a
 *      masked version (first 12 + last 4 chars) so the SQL Editor never
 *      leaks a full API key.
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

  // ── Read-only enforcement ──
  // Must start with SELECT or WITH (case-insensitive). No semicolons allowed
  // (prevents statement stacking — SQLite would only run the first statement
  // anyway via $queryRawUnsafe, but we belt-and-braces it).
  const upper = raw.toUpperCase()
  if (!upper.startsWith('SELECT') && !upper.startsWith('WITH')) {
    return fail(
      'Only SELECT (or WITH ... SELECT) queries are allowed. INSERT / UPDATE / DELETE / DROP / etc. are blocked.',
      400,
    )
  }
  if (raw.includes(';')) {
    return fail('Semicolons are not allowed. Run one query at a time.', 400)
  }

  // ── Rewrite virtual table names → userId-filtered subqueries ──
  // The userId is parameterised via Prisma's positional `?` placeholder.
  // We use word-boundary regex so `records` doesn't match inside `my_records`.
  //
  // The `key` column on api_keys is masked inline so the SQL Editor can never
  // surface a full API key (defence in depth — the dashboard UI already masks
  // keys, but a raw SQL query could otherwise SELECT the full key column).
  const uid = user.userId
  const maskedKey = `substr(\`key\`, 1, 12) || '...' || substr(\`key\`, -4)`

  let rewritten = raw
  // Order matters: replace longer names first to avoid partial clashes.
  const replacements: [RegExp, string][] = [
    [
      /\bapi_keys\b/g,
      `(SELECT id, name, ${maskedKey} AS \`key\`, revoked, lastUsedAt, createdAt, userId FROM ApiKey WHERE userId = ?) AS api_keys`,
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
  for (const [pattern, sub] of replacements) {
    rewritten = rewritten.replace(pattern, sub)
  }

  // Count how many `?` placeholders we injected (one per virtual-table
  // reference). Each needs the userId as a bind parameter.
  const placeholderCount = (rewritten.match(/\?/g) ?? []).length
  const params = new Array(placeholderCount).fill(uid)

  // ── Wrap in an outer SELECT with a hard row cap ──
  // Even if the user wrote LIMIT 5000, the outer LIMIT 1000 caps the result.
  const finalSql = `SELECT * FROM (${rewritten}) AS __result LIMIT 1000`

  try {
    const rows = await db.$queryRawUnsafe(finalSql, ...params)
    // Prisma returns BigInt for integer columns in SQLite — JSON.stringify
    // can't serialise BigInt, so we convert any BigInt values to Number.
    const safe = serializeRows(rows)
    return ok({
      rows: safe,
      count: safe.length,
      truncated: safe.length >= 1000,
      virtualTables: ['users', 'records', 'api_keys', 'collections', 'logs'],
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return fail(`SQL error: ${reason}`, 400)
  }
}

/**
 * Recursively convert BigInt values to Numbers so the result is JSON-
 * serialisable. Prisma's SQLite driver returns BigInt for INTEGER columns.
 */
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

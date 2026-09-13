import { NextRequest } from 'next/server'
import { authenticate, ok, fail, type AuthenticatedUser } from '@/lib/auth'
import {
  listRecords,
  listApiKeys,
  listLogs,
  listCollections,
  findUserByDbId,
} from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /api/v1/graphql
 * Auth: Bearer kv_live_xxx
 * Body: { query, variables? }
 *
 * A minimal, hand-rolled GraphQL endpoint. Supports a subset of the
 * Supabase-style data graph: queries for `records`, `collections`,
 * `apiKeys`, `logs`, `me`. No mutations, no fragments, no aliases —
 * just `{ records { key value } me { userId name plan } }` style reads.
 *
 * All resolvers are user-scoped via `authenticate()`.
 */

interface GqlError {
  message: string
  // locations + path intentionally omitted — minimal spec.
}

interface Selection {
  name: string
  args: Record<string, unknown>
  selection?: Selection[]
}

// ─── Tiny GraphQL query parser ───────────────────────────────────────────────

/**
 * Parse the top-level `{ field { ... } field(args) { ... } }` structure
 * into a list of selections. Doesn't support fragments, aliases, or
 * variables — only the subset the data graph needs.
 */
function parseDocument(query: string): Selection[] {
  // Strip comments.
  const stripped = query.replace(/#[^\n]*/g, '')
  // Find the first `{` after an optional `query`/`mutation` keyword.
  const firstBrace = stripped.indexOf('{')
  if (firstBrace === -1) return []
  // Parse from inside the outermost braces.
  const { selections, pos } = parseSelectionSet(stripped, firstBrace + 1)
  if (pos < stripped.length) {
    // Trailing characters after the closing brace — ignore them silently
    // (real GraphQL would error; we're lenient).
  }
  return selections
}

/**
 * Parse a selection set starting just AFTER the opening `{`.
 * Returns the selections and the position of the matching closing `}` + 1.
 */
function parseSelectionSet(src: string, start: number): {
  selections: Selection[]
  pos: number
} {
  const selections: Selection[] = []
  let i = start
  while (i < src.length) {
    // Skip whitespace + commas.
    while (i < src.length && /[\s,]/.test(src[i])) i++
    if (i >= src.length) break
    if (src[i] === '}') {
      return { selections, pos: i + 1 }
    }

    // Read the field name: letters, digits, underscores.
    let name = ''
    while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) {
      name += src[i]
      i++
    }
    if (!name) {
      // Skip unexpected character (lenient).
      i++
      continue
    }

    // Optional argument list: (key: value, key2: "str", ...)
    const args: Record<string, unknown> = {}
    while (i < src.length && /[\s]/.test(src[i])) i++
    if (src[i] === '(') {
      i++
      let depth = 1
      let argBuf = ''
      while (i < src.length && depth > 0) {
        const ch = src[i]
        if (ch === '(') depth++
        else if (ch === ')') {
          depth--
          if (depth === 0) break
        }
        argBuf += ch
        i++
      }
      i++ // consume ')'
      // Parse `key: value` pairs separated by commas.
      for (const pair of argBuf.split(',')) {
        const m = pair.match(/^\s*([A-Za-z0-9_]+)\s*:\s*(.+?)\s*$/)
        if (!m) continue
        const [, k, rawV] = m
        args[k] = parseValue(rawV)
      }
    }

    // Optional sub-selection: { ... }
    let selection: Selection[] | undefined
    while (i < src.length && /[\s]/.test(src[i])) i++
    if (src[i] === '{') {
      const sub = parseSelectionSet(src, i + 1)
      selection = sub.selections
      i = sub.pos
    }

    selections.push({ name, args, selection })
  }
  return { selections, pos: i }
}

function parseValue(raw: string): unknown {
  const v = raw.trim()
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1)
  }
  // Variable reference like `$limit` — return the raw name; the caller
  // resolves it against `variables` at execution time.
  if (v.startsWith('$')) return { __var: v.slice(1) }
  return v
}

function resolveArg(v: unknown, variables: Record<string, unknown>): unknown {
  if (v && typeof v === 'object' && '__var' in v) {
    return variables[(v as { __var: string }).__var]
  }
  return v
}

// ─── Resolvers ───────────────────────────────────────────────────────────────

function resolveRecords(
  user: AuthenticatedUser,
  sel: Selection[],
  args: Record<string, unknown>,
): unknown[] {
  const collection =
    typeof args.collection === 'string' ? (args.collection as string) : undefined
  const limit =
    typeof args.limit === 'number' ? (args.limit as number) : undefined
  let rows = listRecords(user.dbUserId, collection)
  if (limit !== undefined && limit >= 0) rows = rows.slice(0, limit)
  return rows.map((r) => projectRecord(r, sel))
}

function projectRecord(
  r: {
    key: string
    value: string
    valueType: string
    collection: string
    createdAt: string
    updatedAt: string
  },
  sel: Selection[] | undefined,
): Record<string, unknown> {
  if (!sel || sel.length === 0) {
    // No sub-selection — return the full record.
    let parsed: unknown = r.value
    try {
      parsed = JSON.parse(r.value)
    } catch {
      /* keep raw */
    }
    return {
      key: r.key,
      value: parsed,
      valueType: r.valueType,
      collection: r.collection,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }
  }
  const out: Record<string, unknown> = {}
  for (const f of sel) {
    switch (f.name) {
      case 'key':
        out.key = r.key
        break
      case 'value': {
        let parsed: unknown = r.value
        try {
          parsed = JSON.parse(r.value)
        } catch {
          /* keep raw */
        }
        out.value = parsed
        break
      }
      case 'valueType':
        out.valueType = r.valueType
        break
      case 'collection':
        out.collection = r.collection
        break
      case 'createdAt':
        out.createdAt = r.createdAt
        break
      case 'updatedAt':
        out.updatedAt = r.updatedAt
        break
      default:
        out[f.name] = null
    }
  }
  return out
}

function resolveCollections(
  user: AuthenticatedUser,
  sel: Selection[],
): unknown[] {
  return listCollections(user.dbUserId).map((c) => {
    if (!sel || sel.length === 0) return c
    const out: Record<string, unknown> = {}
    for (const f of sel) {
      switch (f.name) {
        case 'name':
          out.name = c.name
          break
        case 'records':
          out.records = c.records
          break
        case 'createdAt':
          out.createdAt = c.createdAt
          break
        default:
          out[f.name] = null
      }
    }
    return out
  })
}

function resolveApiKeys(
  user: AuthenticatedUser,
  sel: Selection[],
): unknown[] {
  return listApiKeys(user.dbUserId).map((k) => {
    if (!sel || sel.length === 0) return { ...k, key: maskKey(k.key) }
    const out: Record<string, unknown> = {}
    for (const f of sel) {
      switch (f.name) {
        case 'id':
          out.id = k.id
          break
        case 'name':
          out.name = k.name
          break
        case 'key':
          out.key = maskKey(k.key)
          break
        case 'revoked':
          out.revoked = k.revoked
          break
        case 'lastUsedAt':
          out.lastUsedAt = k.lastUsedAt
          break
        case 'createdAt':
          out.createdAt = k.createdAt
          break
        default:
          out[f.name] = null
      }
    }
    return out
  })
}

function maskKey(key: string): string {
  if (key.length <= 16) return key
  return key.slice(0, 12) + '…' + key.slice(-4)
}

function resolveLogs(
  user: AuthenticatedUser,
  sel: Selection[],
  args: Record<string, unknown>,
): unknown[] {
  const limit = typeof args.limit === 'number' ? (args.limit as number) : 100
  const action =
    typeof args.action === 'string' ? (args.action as string) : undefined
  return listLogs(user.dbUserId, { limit, action }).map((l) => {
    if (!sel || sel.length === 0) return l
    const out: Record<string, unknown> = {}
    for (const f of sel) {
      switch (f.name) {
        case 'id':
          out.id = l.id
          break
        case 'action':
          out.action = l.action
          break
        case 'key':
          out.key = l.key
          break
        case 'detail':
          out.detail = l.detail
          break
        case 'source':
          out.source = l.source
          break
        case 'ip':
          out.ip = l.ip
          break
        case 'createdAt':
          out.createdAt = l.createdAt
          break
        default:
          out[f.name] = null
      }
    }
    return out
  })
}

function resolveMe(
  user: AuthenticatedUser,
  sel: Selection[],
): Record<string, unknown> {
  const u = findUserByDbId(user.dbUserId)
  const base: Record<string, unknown> = {
    userId: user.userId,
    name: u?.name ?? null,
    email: u?.email ?? null,
    plan: u?.plan ?? 'free',
    isAdmin: user.isAdmin,
    createdAt: u?.createdAt ?? null,
  }
  if (!sel || sel.length === 0) return base
  const out: Record<string, unknown> = {}
  for (const f of sel) {
    out[f.name] = base[f.name] ?? null
  }
  return out
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized — invalid or missing API key.', 401)

  const body = await req.json().catch(() => null)
  if (!body || typeof body.query !== 'string') {
    return fail('`query` (string) is required.', 400)
  }
  const variables: Record<string, unknown> =
    body.variables && typeof body.variables === 'object'
      ? (body.variables as Record<string, unknown>)
      : {}

  let selections: Selection[]
  try {
    selections = parseDocument(body.query)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return Response.json(
      { data: null, errors: [{ message: `Parse error: ${message}` }] },
      { status: 200 },
    )
  }

  const data: Record<string, unknown> = {}
  const errors: GqlError[] = []

  for (const sel of selections) {
    try {
      // Resolve variables in args.
      const args: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(sel.args)) {
        args[k] = resolveArg(v, variables)
      }
      switch (sel.name) {
        case 'records':
          data.records = resolveRecords(user, sel.selection ?? [], args)
          break
        case 'collections':
          data.collections = resolveCollections(user, sel.selection ?? [])
          break
        case 'apiKeys':
          data.apiKeys = resolveApiKeys(user, sel.selection ?? [])
          break
        case 'logs':
          data.logs = resolveLogs(user, sel.selection ?? [], args)
          break
        case 'me':
          data.me = resolveMe(user, sel.selection ?? [])
          break
        default:
          errors.push({
            message: `Cannot query field "${sel.name}" on type "Query".`,
          })
          data[sel.name] = null
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ message: `Resolver error on "${sel.name}": ${message}` })
      data[sel.name] = null
    }
  }

  // Always 200 — GraphQL conventions put errors in the body, not the status.
  return ok({ data, errors: errors.length > 0 ? errors : undefined }, { status: 200 })
}

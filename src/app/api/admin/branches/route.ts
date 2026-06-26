import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import { authenticateAdmin, ok, fail } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * GET  /api/admin/branches       → list branch snapshots
 * POST /api/admin/branches       → create or restore a snapshot
 *   Body { name }                          → create: copy live DB + JSON cache → db/branches/<name>.{db,json}
 *   Body { name, action: 'restore' }       → restore: copy snapshot back over the live files
 *
 * Auth: Bearer onyxbase_...
 *
 * A "branch" is a point-in-time snapshot of BOTH:
 *   - the SQLite DB file (db/custom.db — used by Prisma + the SQL Editor)
 *   - the in-memory store JSON cache (db/cloudkv.json — the actual source
 *     of truth for records, apiKeys, etc.)
 *
 * Notes:
 *   - Snapshots are stored as files in db/branches/<name>.db + <name>.json.
 *   - Restoring overwrites the live files. For SQLite, an in-flight Prisma
 *     connection may keep a stale view until the server is restarted; the
 *     JSON cache is re-read on the next request. The route returns a hint
 *     about this in the response.
 */

const DB_DIR = path.join(process.cwd(), 'db')
const BRANCH_DIR = path.join(DB_DIR, 'branches')
const LIVE_DB = path.join(DB_DIR, 'custom.db')
const LIVE_JSON = path.join(DB_DIR, 'cloudkv.json')

// Sanity-check the name: 1–64 chars, [a-zA-Z0-9_-] only — no path traversal.
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

function ensureBranchDir(): void {
  if (!fs.existsSync(BRANCH_DIR)) {
    fs.mkdirSync(BRANCH_DIR, { recursive: true })
  }
}

function snapshotExists(name: string): boolean {
  return (
    fs.existsSync(path.join(BRANCH_DIR, `${name}.db`)) ||
    fs.existsSync(path.join(BRANCH_DIR, `${name}.json`))
  )
}

interface BranchMeta {
  name: string
  hasDb: boolean
  hasJson: boolean
  dbBytes: number
  jsonBytes: number
  createdAt: string | null
}

function listBranches(): BranchMeta[] {
  ensureBranchDir()
  const entries = fs.readdirSync(BRANCH_DIR)
  const names = new Set<string>()
  for (const e of entries) {
    if (e.endsWith('.db')) names.add(e.slice(0, -3))
    if (e.endsWith('.json')) names.add(e.slice(0, -5))
  }
  const out: BranchMeta[] = []
  for (const name of Array.from(names).sort()) {
    const dbPath = path.join(BRANCH_DIR, `${name}.db`)
    const jsonPath = path.join(BRANCH_DIR, `${name}.json`)
    const hasDb = fs.existsSync(dbPath)
    const hasJson = fs.existsSync(jsonPath)
    let createdAt: string | null = null
    try {
      const stat = hasDb ? fs.statSync(dbPath) : fs.statSync(jsonPath)
      createdAt = stat.mtime.toISOString()
    } catch {
      /* ignore */
    }
    out.push({
      name,
      hasDb,
      hasJson,
      dbBytes: hasDb ? fs.statSync(dbPath).size : 0,
      jsonBytes: hasJson ? fs.statSync(jsonPath).size : 0,
      createdAt,
    })
  }
  return out
}

function copyIfExists(src: string, dst: string): boolean {
  if (!fs.existsSync(src)) return false
  fs.copyFileSync(src, dst)
  return true
}

export async function GET(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)
  return ok({ branches: listBranches(), dir: BRANCH_DIR })
}

export async function POST(req: NextRequest) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  const body = await req.json().catch(() => null)
  if (!body || typeof body.name !== 'string') {
    return fail('`name` (string) is required.', 400)
  }
  const name = body.name.trim()
  if (!NAME_RE.test(name)) {
    return fail(
      'Branch name must be 1–64 chars of [a-zA-Z0-9_-].',
      400,
    )
  }

  const action =
    typeof body.action === 'string' && body.action === 'restore'
      ? 'restore'
      : 'create'

  ensureBranchDir()
  const dbBranch = path.join(BRANCH_DIR, `${name}.db`)
  const jsonBranch = path.join(BRANCH_DIR, `${name}.json`)

  if (action === 'create') {
    const dbOk = copyIfExists(LIVE_DB, dbBranch)
    const jsonOk = copyIfExists(LIVE_JSON, jsonBranch)
    if (!dbOk && !jsonOk) {
      return fail(
        'No live DB or JSON cache file found to snapshot. Nothing to copy.',
        500,
      )
    }
    return ok({
      action: 'create',
      name,
      dbBytes: fs.existsSync(dbBranch) ? fs.statSync(dbBranch).size : 0,
      jsonBytes: fs.existsSync(jsonBranch) ? fs.statSync(jsonBranch).size : 0,
      createdAt: new Date().toISOString(),
    })
  }

  // restore
  if (!snapshotExists(name)) {
    return fail(`Branch "${name}" not found.`, 404)
  }
  const dbRestored = copyIfExists(dbBranch, LIVE_DB)
  const jsonRestored = copyIfExists(jsonBranch, LIVE_JSON)
  return ok({
    action: 'restore',
    name,
    dbRestored,
    jsonRestored,
    hint:
      'Live files overwritten. JSON cache will be re-read on the next request. ' +
      'For SQLite, an in-flight Prisma connection may need a server restart to ' +
      'pick up the restored DB file.',
  })
}

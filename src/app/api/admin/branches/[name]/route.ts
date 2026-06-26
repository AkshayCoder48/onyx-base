import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import { authenticateAdmin, ok, fail } from '@/lib/auth'

export const runtime = 'nodejs'

/**
 * DELETE /api/admin/branches/{name}
 * Auth: Bearer onyxbase_...
 *
 * Remove a branch snapshot (both .db and .json files in db/branches/).
 */

const BRANCH_DIR = path.join(process.cwd(), 'db', 'branches')
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ name: string }> },
) {
  const user = await authenticateAdmin(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized. Admin key required.', 401)

  const { name } = await ctx.params
  if (!NAME_RE.test(name)) {
    return fail('Branch name must be 1–64 chars of [a-zA-Z0-9_-].', 400)
  }

  const dbPath = path.join(BRANCH_DIR, `${name}.db`)
  const jsonPath = path.join(BRANCH_DIR, `${name}.json`)
  const hadDb = fs.existsSync(dbPath)
  const hadJson = fs.existsSync(jsonPath)
  if (!hadDb && !hadJson) {
    return fail(`Branch "${name}" not found.`, 404)
  }
  if (hadDb) fs.unlinkSync(dbPath)
  if (hadJson) fs.unlinkSync(jsonPath)
  return ok({ action: 'delete', name, removedDb: hadDb, removedJson: hadJson })
}

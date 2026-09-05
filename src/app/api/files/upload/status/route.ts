import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { chunkExpectedSize, validateChunkRefs, type ChunkRef } from '@/lib/chunked-upload'
import { getTelegramConfig } from '@/lib/data-store'
import { getFileDownloadUrl } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * POST /api/files/upload/status — verify staged chunks (STATELESS).
 *
 * Body:     { uploadId, chunkCount, chunkSize, size, chunks: [{ index, fileId, storageMode? }] }
 * Response: { complete, missing, verified, mismatched }
 *
 * Each collected ref is checked against Telegram via `getFile` — a pure
 * metadata call, no bytes are downloaded. Reports:
 *   - missing:   indexes with no ref at all
 *   - mismatched: indexes whose staged size disagrees with the plan
 * so the client knows exactly which chunks to re-send.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let body: {
    chunkCount?: unknown
    chunkSize?: unknown
    size?: unknown
    chunks?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return fail('Expected a JSON body: { chunkCount, chunkSize, size, chunks: [{ index, fileId }] }.', 400)
  }
  const chunkCount = Number(body.chunkCount)
  const chunkSize = Number(body.chunkSize)
  const size = Number(body.size)
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || !Number.isInteger(chunkSize) || !Number.isInteger(size)) {
    return fail('`chunkCount`, `chunkSize` and `size` (integers, echoed from init) are required.', 400)
  }

  const refs = Array.isArray(body.chunks) ? (body.chunks as ChunkRef[]) : []
  const byIndex = new Map<number, ChunkRef>()
  for (const r of refs) {
    if (Number.isInteger(r?.index) && typeof r?.fileId === 'string') byIndex.set(r.index, r)
  }

  const missing: number[] = []
  const mismatched: number[] = []
  let verified = 0
  for (let i = 0; i < chunkCount; i++) {
    const ref = byIndex.get(i)
    if (!ref) {
      missing.push(i)
      continue
    }
    // Resolve the bot that staged this chunk (captured at staging time).
    const bot = resolveBotFor(user.dbUserId, ref.storageMode)
    const expected = chunkExpectedSize(size, chunkSize, chunkCount, i)
    const resolved = await getFileDownloadUrl(ref.fileId, bot.token, bot.apiBase).catch(() => null)
    if (!resolved) {
      mismatched.push(i) // unresolvable → treat as needing a re-send
      continue
    }
    if (resolved.fileSize !== null && resolved.fileSize !== expected) {
      mismatched.push(i)
      continue
    }
    verified++
  }

  return ok({
    complete: missing.length === 0 && mismatched.length === 0,
    missing,
    mismatched,
    verified,
    chunkCount,
  })
}

/** GET is not part of protocol v2 (there is no server-side session to read). */
export async function GET() {
  return fail('Use POST with { chunkCount, chunkSize, size, chunks } — protocol v2 is stateless (no session to query).', 405)
}

function resolveBotFor(dbUserId: string, storageMode?: 'server' | 'custom'): { token: string; apiBase: string } {
  if (storageMode === 'custom') {
    const custom = getTelegramConfig(dbUserId)
    if (custom?.botToken?.trim()) {
      return { token: custom.botToken.trim(), apiBase: custom.botApiBaseUrl?.trim() || '' }
    }
  }
  return { token: process.env.TELEGRAM_BOT_TOKEN || '', apiBase: process.env.TELEGRAM_BOT_API_URL || '' }
}

// Re-export for tree-shaking friendliness in bundlers that analyze side effects.
export type { ChunkRef }

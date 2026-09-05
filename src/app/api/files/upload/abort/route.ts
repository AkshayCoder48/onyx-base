import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { deleteStagedChunks, validUploadId, type ChunkRef } from '@/lib/chunked-upload'
import { getTelegramConfig } from '@/lib/data-store'

export const runtime = 'nodejs'

/**
 * POST /api/files/upload/abort — discard a transfer (STATELESS).
 *
 * Body:     { uploadId, chunks: [{ messageId, storageMode? }] }
 * Response: { deleted, attempted }
 *
 * Deletes every staged Telegram part-message the client collected
 * (best-effort). Call this when giving up so the storage chat doesn't
 * accumulate orphaned `<uploadId>.part*` documents.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let body: { uploadId?: unknown; chunks?: unknown }
  try {
    body = await req.json()
  } catch {
    return fail('Expected a JSON body: { uploadId, chunks: [{ messageId, storageMode? }] }.', 400)
  }
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : ''
  if (!validUploadId(uploadId)) return fail('`uploadId` (UUID from init) is required.', 400)

  const refs = Array.isArray(body.chunks) ? (body.chunks as ChunkRef[]) : []
  const targets = refs
    .filter((r) => Number.isInteger(r?.messageId) && r.messageId > 0)
    .map((r) => ({
      messageId: r.messageId,
      chatId: resolveChat(user.dbUserId, r.storageMode),
      botToken: resolveBot(user.dbUserId, r.storageMode).botToken,
      botApiBaseUrl: resolveBot(user.dbUserId, r.storageMode).botApiBaseUrl,
    }))

  const deleted = await deleteStagedChunks(targets)
  return ok({ deleted, attempted: targets.length })
}

function resolveBot(dbUserId: string, storageMode?: 'server' | 'custom') {
  if (storageMode === 'custom') {
    const custom = getTelegramConfig(dbUserId)
    if (custom?.botToken?.trim()) {
      return { botToken: custom.botToken.trim(), botApiBaseUrl: custom.botApiBaseUrl?.trim() || '' }
    }
  }
  return { botToken: process.env.TELEGRAM_BOT_TOKEN || '', botApiBaseUrl: process.env.TELEGRAM_BOT_API_URL || '' }
}

function resolveChat(dbUserId: string, storageMode?: 'server' | 'custom'): string {
  if (storageMode === 'custom') {
    const custom = getTelegramConfig(dbUserId)
    if (custom?.chatId?.trim()) return custom.chatId.trim()
  }
  return process.env.TELEGRAM_CHAT_ID || ''
}

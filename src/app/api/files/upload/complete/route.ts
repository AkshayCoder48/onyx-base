import { NextRequest } from 'next/server'
import { authenticate, ok, fail, getPublicOrigin } from '@/lib/auth'
import { validateChunkRefs, downloadAndAssemble, deleteStagedChunks, type ChunkRef, type BotTarget } from '@/lib/chunked-upload'
import { uploadFile, fileView, getTelegramConfig } from '@/lib/data-store'
import { logAction } from '@/lib/kv'

export const runtime = 'nodejs'
// Download + assembly + final Telegram transfer can legitimately take minutes.
export const maxDuration = 300

/**
 * POST /api/files/upload/complete — assemble, ship to Telegram, register.
 *
 * Body:      { uploadId, fileName, mimeType, size, chunkSize, chunkCount,
 *              label?, isPublic?, chunks: [{ index, messageId, fileId, storageMode? }] }
 * Response:  { file: FileView } — the same shape as the single-shot
 *            POST /api/files so the UI treats both paths identically.
 *
 * The plan + ALL chunk refs arrive in the body (the client collected them).
 * ANY instance can complete the transfer:
 *   1. coverage validation (exactly 0..chunkCount-1, each once)
 *   2. per-chunk getFile size verification (fail fast on corruption)
 *   3. streamed download of every chunk → reassembly → exact-size check
 *   4. the SAME registration path as single-shot (storage routing, ceilings,
 *      file record, Telegram mirroring)
 *   5. staged chunk messages deleted (best-effort) — the storage chat is left
 *      exactly as it was, now holding the one final document.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  let body: {
    uploadId?: unknown
    fileName?: unknown
    mimeType?: unknown
    size?: unknown
    chunkSize?: unknown
    chunkCount?: unknown
    label?: unknown
    isPublic?: unknown
    chunks?: unknown
  }
  try {
    body = await req.json()
  } catch {
    return fail('Expected a JSON body: { uploadId, fileName, mimeType, size, chunkSize, chunkCount, label?, isPublic?, chunks }.', 400)
  }

  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : ''
  const fileName = typeof body.fileName === 'string' ? body.fileName : ''
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType : 'application/octet-stream'
  const size = Number(body.size)
  const chunkSize = Number(body.chunkSize)
  const chunkCount = Number(body.chunkCount)
  const label = typeof body.label === 'string' ? body.label : null
  const isPublic = body.isPublic !== false
  const refs = Array.isArray(body.chunks) ? (body.chunks as ChunkRef[]) : []

  if (!uploadId) return fail('`uploadId` is required.', 400)
  if (!fileName.trim()) return fail('`fileName` is required.', 400)
  if (!Number.isInteger(size) || size <= 0) return fail('`size` (integer bytes) is required.', 400)
  if (!Number.isInteger(chunkSize) || chunkSize < 256 * 1024) return fail('`chunkSize` (integer, echoed from init) is required.', 400)
  if (!Number.isInteger(chunkCount) || chunkCount < 1) return fail('`chunkCount` (integer, echoed from init) is required.', 400)

  const coverage = validateChunkRefs(chunkCount, refs)
  if (!coverage.ok) return fail(coverage.error, 400)
  // Basic plan sanity (chunk math must reproduce the declared size).
  const lastChunk = size - chunkSize * (chunkCount - 1)
  if (lastChunk <= 0 || lastChunk > chunkSize) {
    return fail('The declared size/chunkSize/chunkCount do not form a consistent plan — re-init.', 400)
  }

  // Resolve the bot per chunk from its captured storageMode.
  const withBots: (ChunkRef & { bot: BotTarget })[] = refs.map((r) => ({ ...r, bot: resolveBot(user.dbUserId, r.storageMode) }))

  let blob: Blob
  try {
    blob = await downloadAndAssemble({ size, chunkSize, chunkCount, mimeType }, withBots)
  } catch (err) {
    return fail(
      err instanceof Error ? err.message : 'Assembly failed. Abort the transfer and retry the upload.',
      400,
    )
  }

  // Reuse the exact same registration path as the single-shot uploader.
  const result = await uploadFile(user.dbUserId, {
    file: blob,
    fileName,
    mimeType,
    size,
    label,
    isPublic,
  })

  // The staged part-messages have served their purpose — always clean up,
  // best-effort, even when the registration failed.
  await deleteStagedChunks(
    withBots.map((r) => ({ messageId: r.messageId, chatId: resolveChat(user.dbUserId, r.storageMode), botToken: r.bot.botToken, botApiBaseUrl: r.bot.botApiBaseUrl })),
  ).catch(() => {})

  if ('error' in result) {
    return fail(result.error, 413)
  }

  await logAction(
    user,
    'file.upload',
    undefined,
    `${fileName} (${size} bytes, chunked ×${chunkCount})`,
    'dashboard',
  ).catch(() => {})

  return ok({ file: fileView(result.record, getPublicOrigin(req)) })
}

function resolveBot(dbUserId: string, storageMode?: 'server' | 'custom'): BotTarget {
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

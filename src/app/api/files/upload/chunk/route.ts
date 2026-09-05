import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { partFileName, stagingCaption, chunkExpectedSize, validUploadId } from '@/lib/chunked-upload'
import { resolveStorageMode, getTelegramConfig } from '@/lib/data-store'
import { sendDocumentFile } from '@/lib/telegram'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * POST /api/files/upload/chunk — stage ONE chunk as a Telegram document.
 *
 * Query:    uploadId, index, chunkCount, chunkSize, size   (echoed from init)
 * Body:     RAW chunk bytes (application/octet-stream)
 * Response: { index, messageId, fileId, storageMode, botApiBaseUrl }
 *
 * STATELESS: the plan fields arrive with every request (the client got them
 * from init), so ANY instance can serve ANY chunk — no session store, no
 * instance affinity, multi-instance-safe by construction.
 *
 * The bytes are forwarded to the user's resolved storage chat (custom bot or
 * the server bot) as document `<uploadId>.part<NNNNNN>` with an ownership
 * caption. The client collects the returned { messageId, fileId } refs and
 * hands them all to `complete`.
 *
 * Retries: a re-sent index stages a NEW document; the client keeps the newest
 * ref per index and cleanup (complete/abort) removes every collected ref.
 */
export async function POST(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const q = req.nextUrl.searchParams
  const uploadId = q.get('uploadId') ?? ''
  const index = Number.parseInt(q.get('index') ?? '', 10)
  const chunkCount = Number.parseInt(q.get('chunkCount') ?? '', 10)
  const chunkSize = Number.parseInt(q.get('chunkSize') ?? '', 10)
  const size = Number.parseInt(q.get('size') ?? '', 10)

  if (!validUploadId(uploadId)) return fail('`uploadId` (UUID from init) is required.', 400)
  if (!Number.isInteger(index) || index < 0) return fail('`index` (integer chunk number) is required.', 400)
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > 10_000) {
    return fail('`chunkCount` (integer, echoed from init) is required.', 400)
  }
  if (!Number.isInteger(chunkSize) || chunkSize < 256 * 1024 || chunkSize > 32 * 1024 * 1024) {
    return fail('`chunkSize` (integer, echoed from init) is required.', 400)
  }
  if (!Number.isInteger(size) || size <= 0) return fail('`size` (integer, echoed from init) is required.', 400)
  if (index >= chunkCount) {
    return fail(`Chunk index ${index} is out of range (0..${chunkCount - 1}).`, 400)
  }

  // Ownership resolution — same routing rule as every other storage write.
  const storageMode = resolveStorageMode(user.dbUserId)
  let chatId: string
  let botToken: string
  let botApiBaseUrl: string
  if (storageMode === 'custom') {
    const custom = getTelegramConfig(user.dbUserId)!
    chatId = custom.chatId.trim()
    botToken = custom.botToken!.trim()
    botApiBaseUrl = custom.botApiBaseUrl?.trim() || ''
  } else {
    chatId = process.env.TELEGRAM_CHAT_ID || ''
    botToken = process.env.TELEGRAM_BOT_TOKEN || ''
    botApiBaseUrl = process.env.TELEGRAM_BOT_API_URL || ''
  }
  if (!chatId || !botToken) {
    return fail(
      storageMode === 'custom'
        ? 'Your custom Telegram configuration is incomplete — set BOTH a Chat ID and a Bot Token in Settings, or clear them to use server-side storage.'
        : 'Telegram storage is not configured on the server. Set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or configure your own bot in Settings.',
      503,
    )
  }

  // Read the body as ONE chunk-sized buffer — memory stays O(chunkSize).
  const body = await req.arrayBuffer().catch(() => null)
  if (!body || body.byteLength === 0) return fail('Empty chunk body.', 400)
  const expected = chunkExpectedSize(size, chunkSize, chunkCount, index)
  if (body.byteLength !== expected) {
    return fail(
      `Chunk ${index} must be exactly ${expected} bytes (got ${body.byteLength}). Re-slice the file with the plan from init.`,
      400,
    )
  }

  const sent = await sendDocumentFile(
    {
      file: new Blob([body], { type: 'application/octet-stream' }),
      fileName: partFileName(uploadId, index),
      mimeType: 'application/octet-stream',
      caption: stagingCaption(user.dbUserId, { size, chunkCount }),
    },
    chatId,
    botToken,
    botApiBaseUrl,
  )
  if (!sent.ok) return fail(sent.error, 502)

  return ok({
    index,
    messageId: sent.document.messageId,
    fileId: sent.document.fileId,
    fileUniqueId: sent.document.fileUniqueId,
    bytes: body.byteLength,
    storageMode,
    botApiBaseUrl: botApiBaseUrl || null,
  })
}

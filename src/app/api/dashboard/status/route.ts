import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { resolveChatId, resolveBotToken, resolveBotApiBaseUrl, getTelegramConfig } from '@/lib/data-store'
import { pingTelegram, effectiveUploadLimitBytes, isUsingLocalBotApi, getBotApiBackendLabel } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * Mask a chat ID for safe display: keep only the sign + first 3 + last 4
 * digits. e.g. "-1001234567890" → "-100…7890". The full chat ID is an
 * operator secret and must never be sent to the browser.
 */
function maskChatId(id: string): string {
  if (!id) return ''
  const sign = id.startsWith('-') ? '-' : ''
  const digits = id.replace(/^-/, '')
  if (digits.length <= 7) return `${sign}…${digits.slice(-4)}`
  return `${sign}${digits.slice(0, 3)}…${digits.slice(-4)}`
}

/** GET /api/dashboard/status — live service + Telegram reachability. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const chatId = resolveChatId(user.dbUserId)
  const botToken = resolveBotToken(user.dbUserId)
  const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)
  const config = getTelegramConfig(user.dbUserId)
  const telegram = await pingTelegram(chatId, botToken, botApiBaseUrl)
  // SECURITY: never return the raw chat ID to the browser. The ping result
  // still carries `chatId` internally (used for logging), but we mask it
  // here so the frontend only ever sees "-100…052".
  const { chatId: _drop, ...telegramSafe } = telegram
  void _drop
  return ok({
    telegram: telegramSafe,
    customConfig: config
      ? {
          chatId: maskChatId(config.chatId),
          label: config.label,
          hasCustomBotToken: config.hasCustomBotToken,
          botApiBaseUrl: config.botApiBaseUrl,
          updatedAt: config.updatedAt,
        }
      : null,
    envChatIdMasked: maskChatId(process.env.TELEGRAM_CHAT_ID || ''),
    envChatIdConfigured: Boolean(process.env.TELEGRAM_CHAT_ID),
    envBotConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    // ─── File upload limit info ───────────────────────────────────────────
    // The effective limit depends on whether a local Bot API server is
    // configured. Cloud = 50 MB upload; local = 2 GB upload. The UI uses these
    // fields to show the right limit badge + disable the upload button for
    // oversized files BEFORE the request hits the server.
    botApiBackend: getBotApiBackendLabel(botApiBaseUrl),
    usingLocalBotApi: isUsingLocalBotApi(botApiBaseUrl),
    maxFileUploadBytes: effectiveUploadLimitBytes(botApiBaseUrl),
    envBotApiUrl: process.env.TELEGRAM_BOT_API_URL || '',
  })
}

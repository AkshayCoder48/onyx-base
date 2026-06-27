import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { resolveChatId, resolveBotToken, resolveBotApiBaseUrl, getTelegramConfig } from '@/lib/data-store'
import { pingTelegram, effectiveUploadLimitBytes, isUsingLocalBotApi, getBotApiBackendLabel } from '@/lib/telegram'

export const runtime = 'nodejs'

/** GET /api/dashboard/status — live service + Telegram reachability. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const chatId = resolveChatId(user.dbUserId)
  const botToken = resolveBotToken(user.dbUserId)
  const botApiBaseUrl = resolveBotApiBaseUrl(user.dbUserId)
  const config = getTelegramConfig(user.dbUserId)
  const telegram = await pingTelegram(chatId, botToken, botApiBaseUrl)
  return ok({
    telegram,
    customConfig: config
      ? {
          chatId: config.chatId,
          label: config.label,
          hasCustomBotToken: config.hasCustomBotToken,
          botApiBaseUrl: config.botApiBaseUrl,
          updatedAt: config.updatedAt,
        }
      : null,
    envChatId: process.env.TELEGRAM_CHAT_ID || '',
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

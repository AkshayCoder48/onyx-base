import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import { resolveChatId, resolveBotToken, getTelegramConfig } from '@/lib/data-store'
import { pingTelegram } from '@/lib/telegram'

export const runtime = 'nodejs'

/** GET /api/dashboard/status — live service + Telegram reachability. */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const chatId = resolveChatId(user.dbUserId)
  const botToken = resolveBotToken(user.dbUserId)
  const config = getTelegramConfig(user.dbUserId)
  const telegram = await pingTelegram(chatId, botToken)
  return ok({
    telegram,
    customConfig: config
      ? {
          chatId: config.chatId,
          label: config.label,
          hasCustomBotToken: config.hasCustomBotToken,
          updatedAt: config.updatedAt,
        }
      : null,
    envChatId: process.env.TELEGRAM_CHAT_ID || '',
    envBotConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
  })
}

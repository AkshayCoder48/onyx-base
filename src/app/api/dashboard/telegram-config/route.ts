import { NextRequest } from 'next/server'
import { authenticate, ok, fail } from '@/lib/auth'
import {
  getTelegramConfig,
  setTelegramConfig,
  clearTelegramConfig,
  clearBotToken,
  resolveChatId,
  resolveBotToken,
} from '@/lib/data-store'
import { pingTelegram } from '@/lib/telegram'

export const runtime = 'nodejs'

/**
 * GET /api/dashboard/telegram-config
 * Returns the user's custom Telegram chat ID config (if any) plus the env default.
 * The bot token is NEVER returned — only whether a custom one is set.
 */
export async function GET(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const config = getTelegramConfig(user.dbUserId)
  return ok({
    customConfig: config
      ? {
          chatId: config.chatId,
          label: config.label,
          hasCustomBotToken: config.hasCustomBotToken,
          updatedAt: config.updatedAt,
        }
      : null,
    envChatId: process.env.TELEGRAM_CHAT_ID || '',
    effectiveChatId: resolveChatId(user.dbUserId),
    envBotConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    hasCustomBotToken: config?.hasCustomBotToken ?? false,
  })
}

/**
 * PUT /api/dashboard/telegram-config
 * Body: { "chatId": "-1001234567890", "label"?: "My channel", "botToken"?: "123:abc" }
 *
 * Sets the user's custom Telegram chat ID and/or bot token.
 * - chatId is required.
 * - botToken is optional. When provided, it is validated against Telegram before saving.
 *   When omitted (undefined), the existing bot token is preserved.
 * - To CLEAR the bot token, send { "botToken": null } or { "clearBotToken": true }.
 */
export async function PUT(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const body = await req.json().catch(() => ({}))
  const chatId = (body.chatId as string)?.trim()
  const label = typeof body.label === 'string' ? body.label.trim() : null
  const botTokenRaw = body.botToken
  const clearBotTokenFlag = body.clearBotToken === true

  if (!chatId) return fail('Chat ID is required.', 400)
  if (!/^-?\d+$/.test(chatId)) {
    return fail(
      'Chat ID must be numeric (e.g. -1001234567890 for a channel, or 123456789 for a private chat).',
      400,
    )
  }

  // Determine the bot token to validate with.
  // - If clearing, use the env default (or empty).
  // - If a new token is provided, use it.
  // - If undefined, use the existing custom token (or env default).
  const existingConfig = getTelegramConfig(user.dbUserId)
  let botTokenToValidate: string | undefined
  let botTokenToStore: string | null | undefined

  if (clearBotTokenFlag || botTokenRaw === null) {
    // Clearing the bot token
    botTokenToStore = null
    botTokenToValidate = undefined // will use env default
  } else if (typeof botTokenRaw === 'string' && botTokenRaw.trim()) {
    // Setting a new bot token
    botTokenToStore = botTokenRaw.trim()
    botTokenToValidate = botTokenToStore
  } else {
    // Preserve existing token
    botTokenToStore = undefined
    botTokenToValidate = existingConfig?.botToken ?? undefined
  }

  // If no custom bot token and no env token, we can't validate.
  const effectiveToken = botTokenToValidate || process.env.TELEGRAM_BOT_TOKEN || ''
  if (!effectiveToken) {
    return fail(
      'No bot token is configured. Provide your own bot token in the request body (botToken field) or ask the operator to set TELEGRAM_BOT_TOKEN.',
      400,
    )
  }

  // Validate the chat ID is reachable by the bot BEFORE saving it.
  const probe = await pingTelegram(chatId, botTokenToValidate)
  if (!probe.ok) {
    return fail(
      `Telegram rejected chat ID ${chatId}: ${probe.error ?? 'unknown error'}. Make sure the bot is an admin of the channel/group, or that you have sent /start to the bot in a private chat.`,
      400,
    )
  }

  const config = setTelegramConfig(user.dbUserId, chatId, label, botTokenToStore)
  return ok({
    customConfig: {
      chatId: config.chatId,
      label: config.label,
      hasCustomBotToken: config.hasCustomBotToken,
      updatedAt: config.updatedAt,
    },
    telegram: probe,
  })
}

/**
 * DELETE /api/dashboard/telegram-config
 * Clears the user's custom chat ID AND bot token (revert to server env defaults).
 */
export async function DELETE(req: NextRequest) {
  const user = await authenticate(req.headers.get('authorization'))
  if (!user) return fail('Unauthorized.', 401)

  const cleared = clearTelegramConfig(user.dbUserId)
  return ok({
    cleared,
    effectiveChatId: resolveChatId(user.dbUserId),
    effectiveBotToken: resolveBotToken(user.dbUserId) ? '(env default)' : '(not configured)',
  })
}

import { NextRequest } from 'next/server'
import { PUT as telegramConfigPut } from '../../dashboard/telegram-config/route'

export const runtime = 'nodejs'

/**
 * POST /api/telegram/connect — connect the caller's private Telegram
 * configuration (PRD §4 Telegram Credential Workflow).
 *
 * Body: { "chatId"?: "-100…", "label"?: "My channel", "botToken"?: "123:abc…" }
 * The chat is pinged with the effective bot token BEFORE saving; invalid
 * pairs are rejected with a safe (non-echoing) error.
 *
 * PRIVACY: for private/sensitive automation, users are instructed (see the
 * dashboard disclaimer + /docs) to bring their OWN Telegram credentials so
 * their configuration channel is not shared with anyone else.
 *
 * Auth: platform API key. Shared handler with the dashboard route.
 */
export async function POST(req: NextRequest) {
  return telegramConfigPut(req)
}

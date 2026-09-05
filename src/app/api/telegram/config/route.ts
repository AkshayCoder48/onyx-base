import { NextRequest } from 'next/server'

export const runtime = 'nodejs'

/**
 * Telegram credential bridge (PRD §4, §15): the user's Telegram destination
 * IS the private configuration channel — named MCPEmail credentials are
 * stored in the caller's account and mirrored to their pinned Telegram
 * manifest, surviving cold boots.
 *
 * GET    /api/telegram/config — connection status (masked chat ID, never the
 *                              bot token; shows env + custom state).
 * PUT    /api/telegram/config — connect a custom chat/bot ({ chatId?, label?,
 *                              botToken?, botApiBaseUrl? }) — validated live
 *                              against Telegram before saving.
 * DELETE /api/telegram/config — revert to the server defaults.
 *
 * Auth: platform API key (kv_live_*). The handlers are shared with the
 * dashboard route (single source of truth).
 */
export { GET, PUT, DELETE } from '../../dashboard/telegram-config/route'

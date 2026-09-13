/**
 * Onyx Base — Telegram Bot API error normalization.
 *
 * Telegram's Bot API returns structured error envelopes:
 *   { "ok": false, "error_code": 401, "description": "Unauthorized" }
 *   { "ok": false, "error_code": 400, "description": "Bad Request: chat not found" }
 *   { "ok": false, "error_code": 429, "description": "Too Many Requests: retry after 5", "parameters": { "retry_after": 5 } }
 *
 * The old code surfaced these as flat strings, which led to misleading UI
 * messages like "Telegram rejected the chat ID: Unauthorized." when the actual
 * problem was that the BOT TOKEN was rejected (Telegram returns "Unauthorized"
 * for both cases — token vs. chat — and the route handler was prepending
 * "rejected the chat ID:" unconditionally).
 *
 * This module parses Telegram's response into a structured `TelegramError`
 * with a `category` field that the route layer can map to a specific,
 * actionable, user-facing message.
 */

export type TelegramErrorCategory =
  | 'authentication' // bot token is invalid / revoked / malformed
  | 'authorization' // bot is not a member of the chat / lacks permissions
  | 'not_found' // chat or message doesn't exist
  | 'rate_limit' // 429 from Telegram
  | 'network' // DNS / connection / timeout / 5xx
  | 'invalid_request' // 400 with a non-recoverable description
  | 'server' // 5xx from Telegram
  | 'unknown'

export interface TelegramError {
  provider: 'telegram'
  /** Raw Telegram error_code (e.g. 400, 401, 429). null when we couldn't parse one. */
  errorCode: number | null
  /** Raw Telegram description string (already scrubbed of operator secrets). */
  description: string
  /** Our normalized category — drives the user-facing message. */
  category: TelegramErrorCategory
  /** When Telegram tells us to retry after N seconds (429), we surface it. */
  retryAfter?: number
  /** When Telegram tells us to migrate to a new chat_id (400), we surface it. */
  migrateToChatId?: number
}

/**
 * Parse a Telegram Bot API JSON response into either a success marker or a
 * structured `TelegramError`. The caller passes the parsed JSON body.
 *
 * Example:
 *   const res = await fetch(`${apiBase}/getMe`)
 *   const body = await res.json()
 *   const err = telegramErrorFromBody(body)
 *   if (err) { ... }
 */
export function telegramErrorFromBody(body: unknown): TelegramError | null {
  if (!body || typeof body !== 'object') return null
  const b = body as { ok?: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number; migrate_to_chat_id?: number } }
  if (b.ok === true) return null
  if (b.ok === undefined && b.error_code === undefined && b.description === undefined) return null

  const errorCode = typeof b.error_code === 'number' ? b.error_code : null
  const description = typeof b.description === 'string' ? b.description : 'Unknown Telegram error.'
  const retryAfter = b.parameters?.retry_after
  const migrateToChatId = b.parameters?.migrate_to_chat_id

  return {
    provider: 'telegram',
    errorCode,
    description,
    category: categorize(errorCode, description),
    retryAfter,
    migrateToChatId,
  }
}

/**
 * Build a TelegramError from a thrown exception (network failure, timeout,
 * DNS error). We never leak the underlying URL (it embeds the bot token).
 */
export function telegramErrorFromException(err: unknown): TelegramError {
  const message = err instanceof Error ? err.message : String(err)
  // The fetch URL contains the bot token; scrub any leaked URL fragments.
  const safe = message.replace(/https?:\/\/[^\s]+/g, '[url]').replace(/\b\d{8,}:[A-Za-z0-9_-]{20,}\b/g, '[bot_token]')
  const isTimeout = /timeout|abort/i.test(message)
  const isDns = /enotfound|eai_again|getaddrinfo/i.test(message)
  return {
    provider: 'telegram',
    errorCode: null,
    description: isTimeout
      ? 'Telegram Bot API did not respond in time.'
      : isDns
        ? 'Could not resolve the Telegram Bot API host. Check your network.'
        : safe || 'Network error reaching the Telegram Bot API.',
    category: 'network',
  }
}

/**
 * Classify a Telegram error_code + description into one of our categories.
 *
 * Mapping rules (based on the official Bot API error codes):
 *   401 "Unauthorized"              → authentication (bot token rejected)
 *   400 "chat not found"            → not_found (chat doesn't exist OR bot has never seen it)
 *   400 "chat admin required"       → authorization (bot is in chat but not admin)
 *   400 "not enough rights"         → authorization (missing permission)
 *   400 "bot is not a member"       → authorization
 *   400 "member list is empty"      → invalid_request
 *   400 (other)                    → invalid_request
 *   403 "Forbidden: bot was blocked by the user"  → authorization
 *   403 (other)                    → authorization
 *   429 "Too Many Requests"         → rate_limit
 *   5xx                             → server
 */
function categorize(errorCode: number | null, description: string): TelegramErrorCategory {
  const d = description.toLowerCase()

  // 401 = bot token problem (Telegram returns "Unauthorized" for bad tokens).
  if (errorCode === 401) return 'authentication'

  // 429 = rate limited.
  if (errorCode === 429) return 'rate_limit'

  // 5xx = Telegram server problem.
  if (errorCode !== null && errorCode >= 500) return 'server'

  // 403 = permission problem (bot was blocked, kicked, lacks rights).
  if (errorCode === 403) return 'authorization'

  // 400 = bad request — needs sub-classification by description text.
  if (errorCode === 400) {
    if (d.includes('chat not found') || d.includes('chat_id_invalid') || d.includes('message to edit not found') || d.includes('message to delete not found')) {
      return 'not_found'
    }
    if (d.includes('not enough rights') || d.includes('admin') || d.includes('bot is not a member') || d.includes('forbidden') || d.includes('kicked') || d.includes('blocked')) {
      return 'authorization'
    }
    return 'invalid_request'
  }

  // Fall back to text-based detection.
  if (d.includes('unauthorized') || d.includes('token')) return 'authentication'
  if (d.includes('chat not found')) return 'not_found'
  if (d.includes('rate') || d.includes('too many')) return 'rate_limit'

  return 'unknown'
}

/**
 * Map a normalized TelegramError to a clear, actionable, USER-FACING message.
 *
 * The principle: NEVER say "Unauthorized" — say WHICH thing was unauthorized
 * (bot token vs. chat vs. permission) and WHAT the user should do next.
 */
export function telegramUserFacingMessage(err: TelegramError): string {
  switch (err.category) {
    case 'authentication':
      return 'Telegram rejected the bot token. The token is invalid, revoked, or malformed. Open @BotFather on Telegram, get a fresh token, and try again.'
    case 'authorization':
      return 'The bot is in the chat but lacks the required permissions (or was kicked / blocked). Add the bot to the channel/supergroup as an administrator, or send /start to the bot in a private chat.'
    case 'not_found':
      return 'The Telegram chat could not be found. Verify the chat ID is correct, and make sure the bot has been added to the channel/supergroup (or that you have sent /start to the bot in a private chat).'
    case 'rate_limit':
      return `Telegram is rate-limiting this bot. Wait ${err.retryAfter ?? 'a few'} second${err.retryAfter === 1 ? '' : 's'} and try again.`
    case 'network':
      return 'Could not reach the Telegram Bot API. The bot token and chat ID were NOT marked invalid — this is a temporary network issue. Try again in a moment.'
    case 'server':
      return 'Telegram is experiencing a server-side issue. Your credentials are still valid. Try again shortly.'
    case 'invalid_request':
      return `Telegram rejected the request: ${err.description}. Check the chat ID format and try again.`
    case 'unknown':
    default:
      return `Telegram reported an unexpected error: ${err.description}. Try again, or check the diagnostics panel.`
  }
}

/**
 * Decide whether a TelegramError is worth retrying. Used by the durable
 * write queue to decide if we should reschedule or give up.
 *
 * Retryable: network, rate_limit, server
 * Non-retryable: authentication, invalid_request
 * Conditional: authorization (might be transient — bot was just added), not_found (chat was just created)
 */
export function isTelegramErrorRetryable(err: TelegramError): boolean {
  if (err.category === 'network' || err.category === 'rate_limit' || err.category === 'server') return true
  if (err.category === 'authorization') return true // bot might just have been added — retry once
  return false
}

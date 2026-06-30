/**
 * Onyx Base — Telegram persistence layer.
 *
 * Every write (set / delete) is mirrored into a private Telegram chat as a
 * structured JSON message. This gives us a durable, human-readable backup that
 * survives full database resets. Message IDs are stored on the Record for
 * later editing / audit.
 *
 * Chat ID + Bot Token resolution: each user can set their OWN chat ID and
 * (optionally) their OWN bot token via the dashboard (stored in data-store).
 * When a user provides a custom bot token, their writes go to their own bot /
 * chat — fully self-hosted storage. When omitted, the server env defaults are
 * used. The bot token is NEVER exposed to the client after it is saved.
 *
 * If Telegram is unreachable we never block the write — we log and continue so
 * the platform stays usable during network issues.
 */

const ENV_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || ''
const ENV_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''

/** Operator-level custom local Bot API server URL (optional). */
const ENV_BOT_API_URL = process.env.TELEGRAM_BOT_API_URL || ''

/** The cloud Bot API base URL (the default when no local server is configured). */
const CLOUD_BOT_API_BASE = 'https://api.telegram.org'

/** Cloud Bot API upload limit — 50 MB per file. */
export const CLOUD_UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024
/** Cloud Bot API download (getFile) limit — 20 MB per file. */
export const CLOUD_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024
/** Max file size with a local Bot API server — 2 GB. */
export const LOCAL_BOT_API_LIMIT_BYTES = 2 * 1024 * 1024 * 1024

/** Resolve the effective bot token: override → env default. */
function resolveBotToken(botTokenOverride?: string): string {
  const t = botTokenOverride?.trim()
  return t || ENV_BOT_TOKEN
}

/**
 * Resolve the effective Bot API base URL (WITHOUT the /bot<token> suffix).
 * Priority: per-call override → env TELEGRAM_BOT_API_URL → cloud default.
 * Returns the bare origin (e.g. `https://api.telegram.org` or `http://localhost:8081`)
 * with no trailing slash.
 */
function resolveBotApiOrigin(botApiBaseUrlOverride?: string): string {
  const url = (botApiBaseUrlOverride?.trim() || ENV_BOT_API_URL || CLOUD_BOT_API_BASE).replace(/\/+$/, '')
  return url
}

/** Compute the Telegram Bot API base URL for a given bot token (+ optional local server). */
function resolveApiBase(botTokenOverride?: string, botApiBaseUrlOverride?: string): string {
  return `${resolveBotApiOrigin(botApiBaseUrlOverride)}/bot${resolveBotToken(botTokenOverride)}`
}

/**
 * Returns the effective custom Bot API base URL (per-user override or env).
 * Empty string means "cloud default (api.telegram.org) is being used".
 */
export function resolveEffectiveBotApiUrl(botApiBaseUrlOverride?: string): string {
  return (botApiBaseUrlOverride?.trim() || ENV_BOT_API_URL || '').trim()
}

/** Whether a custom local Bot API server is in use (per-user override or env). */
export function isUsingLocalBotApi(botApiBaseUrlOverride?: string): boolean {
  return Boolean(resolveEffectiveBotApiUrl(botApiBaseUrlOverride))
}

/**
 * The effective max upload size, in bytes. 2 GB when a local Bot API server is
 * configured, 50 MB otherwise (the cloud Bot API hard limit).
 */
export function effectiveUploadLimitBytes(botApiBaseUrlOverride?: string): number {
  return isUsingLocalBotApi(botApiBaseUrlOverride)
    ? LOCAL_BOT_API_LIMIT_BYTES
    : CLOUD_UPLOAD_LIMIT_BYTES
}

export interface TelegramPayload {
  owner: string
  collection: string
  key: string
  value: unknown
  valueType: string
  updatedAt: number
  op: 'SET' | 'DELETE'
}

export interface EventPayload {
  owner: string
  event: string // signup | login | apikey.create | apikey.revoke | export | collection.create | collection.delete
  detail?: string
  source?: string
  ts: number
}

export function isTelegramConfigured(chatIdOverride?: string, botTokenOverride?: string) {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  return Boolean(resolveBotToken(botTokenOverride) && chatId)
}

/**
 * Human-readable label for the active Bot API backend — shown in the settings UI
 * so the user knows whether they're on the 50 MB cloud path or the 2 GB local path.
 */
export function getBotApiBackendLabel(botApiBaseUrlOverride?: string): string {
  return isUsingLocalBotApi(botApiBaseUrlOverride) ? 'Local Bot API server' : 'Cloud Bot API (api.telegram.org)'
}

/**
 * Fetch wrapper with a hard 5-second timeout. The Telegram API is normally
 * fast (<500ms). If the network is unreachable (e.g. sandbox blocking
 * api.telegram.org), we abort quickly so the request doesn't hang forever
 * and tie up server resources.
 */
function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
}

/**
 * Fire-and-forget wrapper: runs an async function on the next tick without
 * any chance of an unhandled rejection crashing the process. All Telegram
 * sends go through this so a network failure can NEVER take down the server.
 */
function fireAndForget(fn: () => Promise<unknown>): void {
  setImmediate(() => {
    try {
      const p = fn()
      if (p && typeof p.catch === 'function') {
        p.catch(() => {
          /* swallow — Telegram is best-effort */
        })
      }
    } catch {
      /* swallow */
    }
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function formatPayload(payload: TelegramPayload): string {
  const header =
    `🗂 <b>Onyx Base · ${payload.op}</b>\n` +
    `<b>owner:</b> <code>${escapeHtml(payload.owner)}</code>\n` +
    `<b>collection:</b> <code>${escapeHtml(payload.collection)}</code>\n` +
    `<b>key:</b> <code>${escapeHtml(payload.key)}</code>\n` +
    `<b>type:</b> ${escapeHtml(payload.valueType)}\n` +
    `<b>updatedAt:</b> ${payload.updatedAt}\n` +
    `─────────────────`
  const body = escapeHtml(JSON.stringify(payload.value, null, 2))
  return `${header}\n<pre><code class="language-json">${body}</code></pre>`
}

const EVENT_EMOJI: Record<string, string> = {
  signup: '🎉',
  login: '🔐',
  'apikey.create': '🗝️',
  'apikey.revoke': '🚫',
  export: '📤',
  'collection.create': '📁',
  'collection.delete': '🗑️',
}

function formatEvent(payload: EventPayload): string {
  const emoji = EVENT_EMOJI[payload.event] || '📌'
  const lines = [
    `${emoji} <b>Onyx Base · ${escapeHtml(payload.event)}</b>`,
    `<b>owner:</b> <code>${escapeHtml(payload.owner)}</code>`,
  ]
  if (payload.source) lines.push(`<b>source:</b> ${escapeHtml(payload.source)}`)
  if (payload.detail) lines.push(`<b>detail:</b> ${escapeHtml(payload.detail)}`)
  lines.push(`<b>at:</b> ${new Date(payload.ts * 1000).toISOString()}`)
  return lines.join('\n')
}

/** Send a KV operation to the Telegram backup channel. Returns the message id (or null). */
export async function sendKvMessage(
  payload: TelegramPayload,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<number | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null

  try {
    const text = formatPayload(payload)
    const res = await fetchWithTimeout(`${resolveApiBase(botTokenOverride, botApiBaseUrlOverride)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const data = (await res.json()) as { ok: boolean; result?: { message_id: number }; description?: string }
    if (!data.ok) {
      console.error('[telegram] sendMessage failed:', data.description)
      return null
    }
    return data.result?.message_id ?? null
  } catch (err) {
    console.error('[telegram] sendMessage error:', err)
    return null
  }
}

/**
 * Send an account/event notification (signup, login, apikey.create, etc.) to
 * the Telegram channel. Fire-and-forget — never blocks the caller.
 */
export async function sendEventMessage(payload: EventPayload, chatIdOverride?: string, botTokenOverride?: string, botApiBaseUrlOverride?: string): Promise<boolean> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return false
  try {
    const text = formatEvent(payload)
    const res = await fetchWithTimeout(`${resolveApiBase(botTokenOverride, botApiBaseUrlOverride)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const data = (await res.json()) as { ok: boolean; description?: string }
    if (!data.ok) {
      console.error('[telegram] sendEventMessage failed:', data.description)
      return false
    }
    return true
  } catch (err) {
    console.error('[telegram] sendEventMessage error:', err)
    return false
  }
}

/** Edit an existing backup message (used when a key is updated). */
export async function editKvMessage(
  messageId: number,
  payload: TelegramPayload,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<boolean> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return false
  try {
    const text = formatPayload(payload)
    const res = await fetchWithTimeout(`${resolveApiBase(botTokenOverride, botApiBaseUrlOverride)}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const data = (await res.json()) as { ok: boolean; description?: string }
    return data.ok
  } catch (err) {
    console.error('[telegram] editMessageText error:', err)
    return false
  }
}

/** Delete a backup message (used when a key is deleted). */
export async function deleteKvMessage(messageId: number, chatIdOverride?: string, botTokenOverride?: string, botApiBaseUrlOverride?: string): Promise<boolean> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return false
  try {
    const res = await fetchWithTimeout(`${resolveApiBase(botTokenOverride, botApiBaseUrlOverride)}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    })
    const data = (await res.json()) as { ok: boolean; description?: string }
    return data.ok
  } catch (err) {
    console.error('[telegram] deleteMessage error:', err)
    return false
  }
}

// ─── Identity manifest (pinned-message recovery) ─────────────────────────────
//
// Telegram Bot API normally cannot read back messages a bot has sent. The ONE
// exception is the chat's *pinned* message: `getChat` returns it as a full
// Message object (including text). We exploit this to build a durable,
// auto-recoverable identity vault:
//
//   1. On every identity event (user create / apikey create / apikey revoke)
//      we build a JSON manifest of ALL users + apikeys and write it to the
//      chat's pinned message (edit-in-place if our manifest is already pinned,
//      otherwise send + pin a new one).
//   2. On cold boot or on an auth miss, we call `getChat`, read the pinned
//      message text, parse the manifest, and rehydrate the local store.
//
// This makes API keys survive full sandbox resets — the manifest lives in the
// user's Telegram chat and is fetched + matched whenever a key is needed.

/** Marker prefix so we can recognise our own pinned manifest among other pins. */
const MANIFEST_MARKER = 'CLOUDKV_IDENTITY_MANIFEST_V1'

interface PinnedMessage {
  message_id: number
  text: string | null
  caption: string | null
  /** Present when the pinned message is a document (full-state manifest). */
  document?: {
    file_id: string
    file_unique_id: string
    file_name?: string
    mime_type?: string
    file_size?: number
  }
}

interface GetChatResult {
  ok: boolean
  description?: string
  result?: {
    type: string
    title?: string
    username?: string
    pinned_message?: PinnedMessage
  }
}

/**
 * Send (or update) the identity manifest as the chat's pinned message.
 * - If the current pinned message is already our manifest, edit it in place.
 * - Otherwise, send a new message and pin it (unpins the previous pin).
 *
 * Returns the message_id of the pinned manifest, or null on failure.
 */
export async function sendAndPinManifest(
  manifestJson: string,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<number | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null

  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  const text = `${MANIFEST_MARKER}\n${manifestJson}`

  try {
    // 1. Check for an existing pinned manifest we can edit in place.
    const chatRes = await fetchWithTimeout(`${apiBase}/getChat?chat_id=${encodeURIComponent(chatId)}`)
    const chat = (await chatRes.json()) as GetChatResult
    const pinned = chat.result?.pinned_message
    const pinnedText = pinned?.text ?? pinned?.caption ?? null
    const pinnedIsOurs = !!pinned && !!pinnedText && pinnedText.startsWith(MANIFEST_MARKER)

    if (pinnedIsOurs && pinned) {
      // Edit the existing pinned manifest in place.
      const editRes = await fetchWithTimeout(`${apiBase}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: pinned.message_id,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      })
      const editData = (await editRes.json()) as { ok: boolean }
      if (editData.ok) return pinned.message_id
      // fall through to send+pin if edit failed (e.g. content identical)
    }

    // 2. Send a new manifest message and pin it.
    const sendRes = await fetchWithTimeout(`${apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    })
    const sendData = (await sendRes.json()) as {
      ok: boolean
      description?: string
      result?: { message_id: number }
    }
    if (!sendData.ok || !sendData.result) {
      console.error('[telegram] manifest sendMessage failed:', sendData.description)
      return null
    }
    const newMessageId = sendData.result.message_id

    // Pin it. disable_notification = true so it doesn't notify the whole chat.
    const pinRes = await fetchWithTimeout(`${apiBase}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: newMessageId,
        disable_notification: true,
      }),
    })
    const pinData = (await pinRes.json()) as { ok: boolean; description?: string }
    if (!pinData.ok) {
      // Message was sent but couldn't be pinned (bot may not be admin). The
      // manifest still exists in the chat history, just not pinned — we keep
      // the message_id so at least the most recent send is discoverable.
      console.warn('[telegram] pinChatMessage failed (bot may need admin rights):', pinData.description)
    }
    return newMessageId
  } catch (err) {
    console.error('[telegram] sendAndPinManifest error:', err)
    return null
  }
}

/**
 * Fetch the pinned identity manifest from the chat. Returns the raw manifest
 * JSON string (without the marker prefix), or null if the chat has no pinned
 * message, the pin isn't ours, or Telegram is unreachable.
 *
 * Handles BOTH formats:
 *   - Text message (legacy / small manifests): the JSON is inline in the text.
 *   - Document (full-state manifest, ≥ ~3 KB): the pinned message is a
 *     `.json` document whose caption starts with the marker. We fetch the
 *     file_id, download it, and return its contents.
 */
export async function fetchPinnedManifest(
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<string | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  const botToken = resolveBotToken(botTokenOverride)

  try {
    const chatRes = await fetchWithTimeout(`${apiBase}/getChat?chat_id=${encodeURIComponent(chatId)}`)
    const chat = (await chatRes.json()) as GetChatResult
    if (!chat.ok || !chat.result) {
      console.error('[telegram] getChat failed for manifest fetch:', chat.description)
      return null
    }
    const pinned = chat.result.pinned_message
    if (!pinned) return null

    // Case 1: text manifest (small / legacy).
    const pinnedText = pinned.text ?? null
    if (pinnedText && pinnedText.startsWith(MANIFEST_MARKER)) {
      return pinnedText.slice(MANIFEST_MARKER.length).trim()
    }

    // Case 2: document manifest (full state). The JSON is in the document,
    // the marker is in the caption.
    const pinnedCaption = pinned.caption ?? null
    const doc = pinned.document
    if (doc && pinnedCaption && pinnedCaption.startsWith(MANIFEST_MARKER) && doc.file_id) {
      // Resolve a fresh download URL for the document's file_id.
      const dl = await getFileDownloadUrl(doc.file_id, botTokenOverride, botApiBaseUrlOverride)
      if (!dl) {
        console.error('[telegram] full-state manifest: getFile failed for file_id', doc.file_id)
        return null
      }
      const fileRes = await fetchWithTimeout(dl.url)
      if (!fileRes.ok) {
        console.error('[telegram] full-state manifest: download failed', fileRes.status)
        return null
      }
      return await fileRes.text()
    }

    return null
  } catch (err) {
    console.error('[telegram] fetchPinnedManifest error:', err)
    return null
  }
}

/**
 * Send (or edit) the full-state manifest as a pinned Telegram **document**.
 *
 * Why a document, not a text message? Telegram caps text messages at 4096
 * chars — far too small for a manifest containing records, logs, files, etc.
 * Documents support up to 50 MB (cloud Bot API) or 2 GB (local Bot API), so
 * the entire app state fits with room to spare. This is the durability layer
 * that makes Onyx Base work on serverless (Vercel) — every write updates this
 * pinned document, and every cold boot reads it back. Free + unlimited.
 *
 * The caption carries the marker so `fetchPinnedManifest` recognises it.
 */
export async function sendAndPinFullState(
  stateJson: string,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<number | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  const caption = `${MANIFEST_MARKER}\nfull-state`

  try {
    // 1. Check for an existing pinned full-state document we can replace.
    const chatRes = await fetchWithTimeout(`${apiBase}/getChat?chat_id=${encodeURIComponent(chatId)}`)
    const chat = (await chatRes.json()) as GetChatResult
    const pinned = chat.result?.pinned_message
    const pinnedCaption = pinned?.caption ?? null
    const pinnedIsOurs = !!pinned && !!pinnedCaption && pinnedCaption.startsWith(MANIFEST_MARKER)

    // Build the document payload once.
    const bytes = Buffer.from(stateJson, 'utf-8')
    const blob = new Blob([bytes], { type: 'application/json' })
    const fileName = `onyxbase-state.json`

    if (pinnedIsOurs && pinned?.message_id) {
      // Delete the old pinned document, then send a fresh one.
      // (Telegram has no editMessageDocument for arbitrary files — we must
      // delete + resend. The new message gets re-pinned below.)
      try {
        await fetchWithTimeout(`${apiBase}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: pinned.message_id }),
        })
      } catch {
        // swallow — stale pin will be replaced
      }
    }

    // 2. Send the new full-state document.
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('document', blob, fileName)
    form.append('caption', caption.slice(0, 1024))
    form.append('disable_notification', 'true')

    const sendRes = await fetch(`${apiBase}/sendDocument`, { method: 'POST', body: form })
    const sendData = (await sendRes.json()) as {
      ok: boolean
      description?: string
      result?: { message_id: number }
    }
    if (!sendData.ok || !sendData.result) {
      console.error('[telegram] full-state sendDocument failed:', sendData.description)
      return null
    }
    const newMessageId = sendData.result.message_id

    // 3. Pin it.
    const pinRes = await fetchWithTimeout(`${apiBase}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: newMessageId, disable_notification: true }),
    })
    const pinData = (await pinRes.json()) as { ok: boolean; description?: string }
    if (!pinData.ok) {
      console.warn('[telegram] full-state pinChatMessage failed:', pinData.description)
    }
    return newMessageId
  } catch (err) {
    console.error('[telegram] sendAndPinFullState error:', err)
    return null
  }
}

// ─── V4: Per-account manifests ───────────────────────────────────────────────
//
// Problem with V3 (sendAndPinFullState): ONE pinned document holds ALL users'
// data. As any single user grows, the whole blob grows, and every write
// re-uploads the entire world's data. A single power user could push the file
// toward the 50 MB cloud limit and break the platform for everyone.
//
// V4 splits storage by account:
//
//   1. A tiny PINNED INDEX message (text, <4 KB, always fits) carries a
//      `userId → { messageId, fileId, recordCount, bytes, updatedAt }` map.
//      This is the only pinned message — cheap to fetch + re-pin.
//
//   2. One NON-PINNED document message per account, captioned
//      `CLOUDKV_ACCOUNT_MANIFEST_V4\nuserId=usr_xxx`. Each carries ONLY that
//      user's records / logs / files / shareTokens / collectionNames /
//      telegramConfigs. Each grows independently — one user hitting 40 MB
//      doesn't affect anyone else.
//
//   3. System data (adminKeys, the admin user itself) lives in a special
//      account manifest with userId='__system__'.
//
// Telegram only allows ONE pinned message per chat, so per-account manifests
// are regular messages whose message_ids are tracked by the pinned index.
//
// Backward compatibility: the old V3 full-state pin is left IN PLACE during
// migration (never deleted) — it serves as a fallback + backup. The V4 index
// is pinned on top of it (Telegram auto-unpins the old one), but the old
// message stays in the chat history and `fetchPinnedManifest` (V3 path) is
// kept working as a fallback if the V4 index is ever lost.

/** Marker for the V4 pinned account index. */
const ACCOUNT_INDEX_MARKER = 'CLOUDKV_ACCOUNT_INDEX_V4'

/** Marker prefix for per-account manifest documents (caption). */
const ACCOUNT_MANIFEST_MARKER = 'CLOUDKV_ACCOUNT_MANIFEST_V4'

/** Special userId for system-wide data (adminKeys, admin user). */
export const SYSTEM_ACCOUNT_ID = '__system__'

/** One entry in the pinned V4 account index. */
export interface AccountIndexEntry {
  /** Public userId (e.g. `usr_abc123`) or `__system__`. */
  userId: string
  /** Telegram message_id of the account's manifest document. */
  messageId: number
  /** Telegram file_id of the manifest document (for re-download). */
  fileId: string
  /** Approximate byte size of the manifest document. */
  bytes: number
  /** Number of records in this account's manifest (for admin display). */
  recordCount: number
  /** ISO timestamp of the last sync. */
  updatedAt: string
}

/** Shape of the pinned V4 index message body. */
export interface AccountIndex {
  cloudkv: true
  kind: 'account-index'
  version: 4
  exportedAt: string
  /** `userId → entry`. */
  accounts: Record<string, AccountIndexEntry>
}

/** Shape of a single account's manifest document. */
export interface AccountManifest {
  cloudkv: true
  kind: 'account-manifest'
  version: 4
  /** Which account this manifest belongs to (`usr_xxx` or `__system__`). */
  userId: string
  exportedAt: string
  user: unknown | null
  apiKeys: unknown[]
  records: unknown[]
  logs: unknown[]
  files: unknown[]
  shareTokens: unknown[]
  collectionNames: unknown[]
  telegramConfigs: unknown[]
  /** Present only on the __system__ manifest. */
  adminKeys?: unknown[]
}

/**
 * Fetch + parse the pinned V4 account index. Returns null if Telegram is not
 * configured, the pin is missing, or the pin is not ours (e.g. still a V3
 * full-state manifest — caller should fall back to fetchPinnedManifest).
 */
export async function fetchAccountIndex(
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<AccountIndex | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  try {
    const chatRes = await fetchWithTimeout(`${apiBase}/getChat?chat_id=${encodeURIComponent(chatId)}`)
    const chat = (await chatRes.json()) as GetChatResult
    if (!chat.ok || !chat.result) return null
    const pinned = chat.result.pinned_message
    if (!pinned) return null
    // The index is a TEXT message (small). If the pin is a document, it's a
    // V3 full-state manifest — not ours.
    const text = pinned.text ?? null
    if (!text || !text.startsWith(ACCOUNT_INDEX_MARKER)) return null
    const json = text.slice(ACCOUNT_INDEX_MARKER.length).trim()
    const parsed = JSON.parse(json) as AccountIndex
    if (parsed.cloudkv !== true || parsed.kind !== 'account-index' || parsed.version !== 4) return null
    return parsed
  } catch (err) {
    console.error('[telegram] fetchAccountIndex error:', err)
    return null
  }
}

/**
 * Write (or overwrite) the pinned V4 account index. Replaces whatever is
 * currently pinned (including a V3 full-state document — that message stays in
 * the chat history but is no longer pinned). Returns the new pinned message_id
 * or null on failure.
 */
export async function pinAccountIndex(
  index: AccountIndex,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<number | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  const text = `${ACCOUNT_INDEX_MARKER}\n${JSON.stringify(index)}`
  try {
    const chatRes = await fetchWithTimeout(`${apiBase}/getChat?chat_id=${encodeURIComponent(chatId)}`)
    const chat = (await chatRes.json()) as GetChatResult
    const pinned = chat.result?.pinned_message
    const pinnedText = pinned?.text ?? null
    const pinnedIsOurIndex = !!pinned && !!pinnedText && pinnedText.startsWith(ACCOUNT_INDEX_MARKER)
    if (pinnedIsOurIndex && pinned) {
      const editRes = await fetchWithTimeout(`${apiBase}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: pinned.message_id,
          text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      })
      const editData = (await editRes.json()) as { ok: boolean }
      if (editData.ok) return pinned.message_id
    }
    const sendRes = await fetchWithTimeout(`${apiBase}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    })
    const sendData = (await sendRes.json()) as { ok: boolean; description?: string; result?: { message_id: number } }
    if (!sendData.ok || !sendData.result) {
      console.error('[telegram] pinAccountIndex sendMessage failed:', sendData.description)
      return null
    }
    const newMessageId = sendData.result.message_id
    const pinRes = await fetchWithTimeout(`${apiBase}/pinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: newMessageId, disable_notification: true }),
    })
    const pinData = (await pinRes.json()) as { ok: boolean; description?: string }
    if (!pinData.ok) console.warn('[telegram] pinAccountIndex pinChatMessage failed:', pinData.description)
    return newMessageId
  } catch (err) {
    console.error('[telegram] pinAccountIndex error:', err)
    return null
  }
}

/**
 * Send (or replace) a single account's manifest document. Returns the new
 * message_id + file_id, or null on failure. Does NOT touch the pinned index —
 * the caller must update the index afterwards via pinAccountIndex.
 *
 * If `replaceMessageId` is supplied, that old message is deleted first
 * (Telegram has no editMessageDocument for arbitrary files). The new message is
 * NOT pinned (only the index is pinned in V4).
 */
export async function sendAccountManifest(
  manifest: AccountManifest,
  replaceMessageId?: number,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<{ messageId: number; fileId: string; bytes: number } | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  const json = JSON.stringify(manifest)
  const bytes = Buffer.byteLength(json, 'utf-8')
  const caption = `${ACCOUNT_MANIFEST_MARKER}\nuserId=${manifest.userId}`
  try {
    // Delete the previous version of this account's manifest (if any).
    if (replaceMessageId) {
      try {
        await fetchWithTimeout(`${apiBase}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: replaceMessageId }),
        })
      } catch {
        /* swallow — stale message will be orphaned, not fatal */
      }
    }
    const blob = new Blob([Buffer.from(json, 'utf-8')], { type: 'application/json' })
    const fileName = `onyxbase-account-${manifest.userId}.json`
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('document', blob, fileName)
    form.append('caption', caption.slice(0, 1024))
    form.append('disable_notification', 'true')
    const sendRes = await fetch(`${apiBase}/sendDocument`, { method: 'POST', body: form })
    const sendData = (await sendRes.json()) as {
      ok: boolean
      description?: string
      result?: { message_id: number; document?: { file_id: string } }
    }
    if (!sendData.ok || !sendData.result || !sendData.result.document) {
      console.error('[telegram] sendAccountManifest sendDocument failed:', sendData.description)
      return null
    }
    return {
      messageId: sendData.result.message_id,
      fileId: sendData.result.document.file_id,
      bytes,
    }
  } catch (err) {
    console.error('[telegram] sendAccountManifest error:', err)
    return null
  }
}

/**
 * Fetch + parse a single account's manifest document by its message_id +
 * file_id (both tracked in the pinned index). Returns null if the message is
 * gone or the download fails.
 */
export async function fetchAccountManifest(
  fileId: string,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<AccountManifest | null> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) return null
  try {
    const dl = await getFileDownloadUrl(fileId, botTokenOverride, botApiBaseUrlOverride)
    if (!dl) {
      console.error('[telegram] fetchAccountManifest: getFile failed for', fileId)
      return null
    }
    const fileRes = await fetchWithTimeout(dl.url)
    if (!fileRes.ok) {
      console.error('[telegram] fetchAccountManifest: download failed', fileRes.status)
      return null
    }
    const text = await fileRes.text()
    const parsed = JSON.parse(text) as AccountManifest
    if (parsed.cloudkv !== true || parsed.kind !== 'account-manifest' || parsed.version !== 4) return null
    return parsed
  } catch (err) {
    console.error('[telegram] fetchAccountManifest error:', err)
    return null
  }
}

/**
 * Health check used by the dashboard status panel. Calls getChat to verify the
 * bot can actually reach the configured chat (without sending a message) and
 * returns the Telegram error description on failure so the UI can surface
 * actionable guidance (e.g. "start the bot first").
 *
 * If `chatIdOverride` is supplied, validates that specific chat ID (used for
 * per-user custom chat IDs). Otherwise validates the env default.
 */
export async function pingTelegram(chatIdOverride?: string, botTokenOverride?: string, botApiBaseUrlOverride?: string): Promise<{
  ok: boolean
  chatId: string
  chatType?: string
  error?: string
}> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  const botToken = resolveBotToken(botTokenOverride)
  if (!botToken || !chatId) {
    return { ok: false, chatId, error: 'Not configured (bot token or chat ID missing).' }
  }
  try {
    const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
    const meRes = await fetchWithTimeout(`${apiBase}/getMe`)
    const me = (await meRes.json()) as { ok: boolean; result?: { username: string }; description?: string }
    if (!me.ok) return { ok: false, chatId, error: `Bot token rejected: ${me.description || 'unknown error'}.` }

    const chatRes = await fetchWithTimeout(`${apiBase}/getChat?chat_id=${chatId}`)
    const chat = (await chatRes.json()) as {
      ok: boolean
      result?: { type: string; title?: string; username?: string }
      description?: string
    }
    if (!chat.ok) {
      // SECURITY: do NOT echo the bot @username, the chat ID, or the chat
      // title into the error — these are operator secrets. Surface only the
      // generic Telegram reason (e.g. "Bad Request: chat not found") plus
      // actionable guidance.
      return {
        ok: false,
        chatId,
        error: chat.description || 'Chat is not reachable by this bot.',
      }
    }
    return {
      ok: true,
      chatId,
      chatType: chat.result?.type,
    }
  } catch {
    // Don't leak the Bot API origin (could be a private local server URL).
    return { ok: false, chatId, error: 'Network error reaching the Telegram Bot API.' }
  }
}

// ─── File storage (documents up to 2 GB) ─────────────────────────────────────
//
// Files are uploaded to Telegram via `sendDocument` (multipart/form-data) and
// stored as Telegram messages. We keep the returned `file_id` so we can later
// call `getFile` to resolve a fresh, temporary download URL — exactly the
// "file-to-link proxy" pattern: the public permanent link hits our server, we
// fetch a fresh URL from Telegram behind the scenes, and pipe the byte stream
// straight back to the user. The Telegram download URL is never exposed.
//
// NOTE on limits:
//   - Cloud Bot API (api.telegram.org, the default): uploads capped at 50 MB,
//     `getFile` downloads capped at 20 MB.
//   - Local Bot API server (self-hosted, optional): both limits raised to 2 GB.
// The app enforces the right limit based on which backend is configured, so the
// user gets a clear "file too large" error BEFORE we waste a round-trip to
// Telegram.

export interface SentDocument {
  messageId: number
  fileId: string
  fileUniqueId: string
  fileName: string | null
  mimeType: string | null
  fileSize: number | null
}

/** Result of `sendDocumentFile` — either success (with the document) or a structured failure with a human-readable error. */
export type SendDocumentResult =
  | { ok: true; document: SentDocument }
  | { ok: false; error: string }

/**
 * Upload a file (as a Blob/Buffer + filename + mime) to a Telegram chat using
 * `sendDocument`. Returns the message id + the Telegram file_id we need to
 * re-fetch the file later. The file is sent with `disable_notification` so it
 * doesn't spam the chat.
 *
 * Returns `{ ok: false, error }` (NOT null) on failure, with the ACTUAL Telegram
 * error description surfaced — so callers can show the user the real reason
 * (e.g. "Unauthorized", "chat not found") instead of a misleading guess.
 */
export async function sendDocumentFile(
  payload: {
    file: Blob
    fileName: string
    mimeType: string
    caption?: string
  },
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<SendDocumentResult> {
  const chatId = chatIdOverride ?? ENV_CHAT_ID
  if (!isTelegramConfigured(chatId, botTokenOverride)) {
    return { ok: false, error: 'Telegram is not configured (missing bot token or chat ID).' }
  }
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)

  try {
    const form = new FormData()
    form.append('chat_id', chatId)
    form.append('document', payload.file, payload.fileName)
    form.append('disable_notification', 'true')
    if (payload.caption) form.append('caption', payload.caption.slice(0, 1024))

    // No artificial timeout on uploads — large files legitimately take a while.
    const res = await fetch(`${apiBase}/sendDocument`, {
      method: 'POST',
      body: form,
    })
    const data = (await res.json()) as {
      ok: boolean
      description?: string
      result?: {
        message_id: number
        document?: {
          file_id: string
          file_unique_id: string
          file_name?: string
          mime_type?: string
          file_size?: number
        }
      }
    }
    if (!data.ok || !data.result?.document) {
      const desc = data.description || 'unknown error'
      // Surface Telegram's actual error so the user knows the real cause
      // (e.g. "Unauthorized" for a bad token, "Bad Request: CHAT_ID_INVALID"
      // for an unreachable chat) — NOT a misleading "50 MB limit" guess.
      return { ok: false, error: `Telegram rejected the upload: ${desc}` }
    }
    const doc = data.result.document
    return {
      ok: true,
      document: {
        messageId: data.result.message_id,
        fileId: doc.file_id,
        fileUniqueId: doc.file_unique_id,
        fileName: doc.file_name ?? null,
        mimeType: doc.mime_type ?? null,
        fileSize: doc.file_size ?? null,
      },
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return { ok: false, error: `Network error reaching Telegram: ${msg}` }
  }
}

/**
 * Resolve a fresh, temporary download URL for a Telegram file via `getFile`.
 * The returned URL is valid for at least 1 hour. Our download proxy calls this
 * on every request so links stay permanent from the user's point of view.
 */
export async function getFileDownloadUrl(
  fileId: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<{ url: string; fileSize: number | null } | null> {
  const botToken = resolveBotToken(botTokenOverride)
  if (!botToken) return null
  const apiBase = resolveApiBase(botTokenOverride, botApiBaseUrlOverride)
  const fileBase = resolveBotApiOrigin(botApiBaseUrlOverride)

  try {
    const res = await fetchWithTimeout(
      `${apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`,
    )
    const data = (await res.json()) as {
      ok: boolean
      description?: string
      result?: { file_path?: string; file_size?: number }
    }
    if (!data.ok || !data.result?.file_path) {
      console.error('[telegram] getFile failed:', data.description)
      return null
    }
    // Download URL format: <origin>/file/bot<token>/<file_path>
    // Works for both cloud (api.telegram.org) and local Bot API servers.
    return {
      url: `${fileBase}/file/bot${botToken}/${data.result.file_path}`,
      fileSize: data.result.file_size ?? null,
    }
  } catch (err) {
    console.error('[telegram] getFile error:', err)
    return null
  }
}

// ─── getFile URL cache (anti-spam for Telegram) ──────────────────────────────
//
// Telegram's `getFile` returns a temporary download URL that stays valid for
// ~1 hour. If we called `getFile` on EVERY download request, we would spam the
// Telegram API — exactly what we want to avoid. So we cache the resolved URL
// per (botToken, fileId) pair for 55 minutes (just under Telegram's 1-hour
// expiry, with a safety buffer). Within that window, every download reuses the
// cached URL and makes ZERO calls to Telegram. The cache is process-local and
// in-memory — good enough for a single-instance deployment.
//
// This is the server-side half of the "only request a new link when the user
// taps the button" design: even if many users download the same file, or the
// same user downloads repeatedly, Telegram only sees ONE getFile call per hour
// per file.

interface CachedFileUrl {
  url: string
  fileSize: number | null
  /** Epoch-ms timestamp at which this cached URL stops being valid. */
  expiresAt: number
}

/** 55 minutes — just under Telegram's ~1-hour URL expiry, with a safety buffer. */
const FILE_URL_CACHE_TTL_MS = 55 * 60 * 1000

/** Keyed by `${botTokenFingerprint}:${fileId}` to keep server/custom bots apart. */
const fileUrlCache = new Map<string, CachedFileUrl>()

/** Short, non-reversible fingerprint of the bot token + API backend so we can key the cache by it without storing the raw token. */
function tokenFingerprint(botTokenOverride?: string, botApiBaseUrlOverride?: string): string {
  const t = resolveBotToken(botTokenOverride)
  // First + last 4 chars is enough to distinguish bots without leaking the full secret.
  const tf = t ? `${t.slice(0, 4)}…${t.slice(-4)}` : 'none'
  // Include a fingerprint of the API backend so cloud and local server URLs
  // don't collide in the cache (a file_id from the cloud API is NOT the same
  // as one from a local Bot API server, even for the same bot token).
  const uf = isUsingLocalBotApi(botApiBaseUrlOverride)
    ? resolveEffectiveBotApiUrl(botApiBaseUrlOverride).replace(/^https?:\/\//, '').slice(0, 20)
    : 'cloud'
  return `${uf}:${tf}`
}

/**
 * Return a download URL for a Telegram file, hitting the in-memory cache when
 * possible. Only calls Telegram's `getFile` when no cached URL exists OR the
 * cached URL is within 5 minutes of expiry (proactive refresh to avoid serving
 * a URL that's about to die). This is what the download proxy and the
 * "Get link" endpoint should call — NEVER the raw `getFileDownloadUrl`.
 */
export async function getCachedFileDownloadUrl(
  fileId: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<{ url: string; fileSize: number | null; expiresAt: number } | null> {
  const cacheKey = `${tokenFingerprint(botTokenOverride, botApiBaseUrlOverride)}:${fileId}`
  const now = Date.now()
  const cached = fileUrlCache.get(cacheKey)

  // Cache hit AND not within the 5-minute pre-expiry refresh window.
  if (cached && cached.expiresAt - now > 5 * 60 * 1000) {
    return { url: cached.url, fileSize: cached.fileSize, expiresAt: cached.expiresAt }
  }

  // Cache miss or about to expire → call Telegram for a fresh URL.
  const fresh = await getFileDownloadUrl(fileId, botTokenOverride, botApiBaseUrlOverride)
  if (!fresh) return null

  const entry: CachedFileUrl = {
    url: fresh.url,
    fileSize: fresh.fileSize,
    expiresAt: now + FILE_URL_CACHE_TTL_MS,
  }
  fileUrlCache.set(cacheKey, entry)
  return { url: entry.url, fileSize: entry.fileSize, expiresAt: entry.expiresAt }
}

/**
 * Return the Telegram DIRECT download URL (`https://api.telegram.org/file/bot…/…`)
 * for a file, with the same caching semantics as `getCachedFileDownloadUrl`.
 *
 * This is the "give me Telegram's cloud link" function: the URL it returns is
 * the RAW Telegram URL (with the bot token embedded in the path). Telegram
 * revokes it after ~1 hour. The caller is responsible for surfacing this as a
 * time-limited link — never cache it client-side for more than ~1 hour.
 *
 * Used by the POST /api/files/[id]/link endpoint so the UI can show the user
 * the actual Telegram cloud link (instead of a proxied URL on our origin).
 */
export async function getCachedTelegramDirectUrl(
  fileId: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<{ url: string; fileSize: number | null; expiresAt: number } | null> {
  // Same cache, same semantics — the cached URL IS the Telegram direct URL.
  return getCachedFileDownloadUrl(fileId, botTokenOverride, botApiBaseUrlOverride)
}

/**
 * Drop a file's cached download URL (e.g. after the file is deleted, or when
 * the user explicitly requests a fresh link via the "Get link" button). The
 * next `getCachedFileDownloadUrl` call will re-fetch from Telegram.
 */
export function invalidateCachedFileUrl(fileId: string, botTokenOverride?: string, botApiBaseUrlOverride?: string): void {
  const cacheKey = `${tokenFingerprint(botTokenOverride, botApiBaseUrlOverride)}:${fileId}`
  fileUrlCache.delete(cacheKey)
}

/** Delete the Telegram message that holds a stored file (cleanup on delete). */
export async function deleteFileMessage(
  messageId: number,
  chatIdOverride?: string,
  botTokenOverride?: string,
  botApiBaseUrlOverride?: string,
): Promise<boolean> {
  // Reuses the same deleteMessage call as KV messages — a document message is
  // just another message id from Telegram's point of view.
  return deleteKvMessage(messageId, chatIdOverride, botTokenOverride, botApiBaseUrlOverride)
}

/**
 * Onyx Base — one-off Telegram chat cleanup.
 *
 * Telegram Bot API has no "clear all messages" endpoint, so we:
 *   1. Call getChat to find the pinned message (our identity manifest) → unpin + delete it.
 *   2. Iterate message_id = 1..MAX in batches of 100 via deleteMessages (plural).
 *      Telegram returns 400 if ANY id in the batch is missing/undeletable, so
 *      on failure we fall back to per-id deleteMessage and swallow errors.
 *   3. Stop early after N consecutive empty batches.
 *
 * Run:  bun run scripts/telegram-cleanup.ts
 *
 * This does NOT touch TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env —
 * the chat itself stays configured, only its contents are wiped.
 */
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN!
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!
const API = `https://api.telegram.org/bot${BOT_TOKEN}`

if (!BOT_TOKEN || !CHAT_ID) {
  console.error('[cleanup] TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set in env.')
  process.exit(1)
}

async function getChat() {
  const r = await fetch(`${API}/getChat?chat_id=${encodeURIComponent(CHAT_ID)}`)
  return (await r.json()) as {
    ok: boolean
    description?: string
    result?: { pinned_message?: { message_id: number; text?: string | null; caption?: string | null } }
  }
}

async function unpinMessage(messageId: number): Promise<boolean> {
  try {
    const r = await fetch(`${API}/unpinChatMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId }),
    })
    const j = (await r.json()) as { ok: boolean }
    return j.ok
  } catch {
    return false
  }
}

async function deleteOne(messageId: number): Promise<boolean> {
  try {
    const r = await fetch(`${API}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_id: messageId }),
    })
    const j = (await r.json()) as { ok: boolean; description?: string }
    return j.ok
  } catch {
    return false
  }
}

async function deleteBatch(ids: number[]): Promise<number> {
  // Try batched delete first.
  try {
    const r = await fetch(`${API}/deleteMessages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, message_ids: ids }),
    })
    const j = (await r.json()) as { ok: boolean }
    if (j.ok) return ids.length
  } catch {
    /* fall through */
  }
  // Batch failed (some id missing). Fall back to per-id.
  let count = 0
  for (const id of ids) {
    if (await deleteOne(id)) count++
  }
  return count
}

async function main() {
  console.log(`[cleanup] Onyx Base chat cleanup — bot=${BOT_TOKEN.slice(0, 8)}… chat=${CHAT_ID}`)

  // 1. Unpin + delete the pinned manifest.
  const chat = await getChat()
  if (!chat.ok) {
    console.error('[cleanup] getChat failed:', chat.description)
  } else if (chat.result?.pinned_message) {
    const pinnedId = chat.result.pinned_message.message_id
    console.log(`[cleanup] found pinned message id=${pinnedId}, unpinning…`)
    await unpinMessage(pinnedId)
    console.log(`[cleanup] deleting pinned message id=${pinnedId}…`)
    await deleteOne(pinnedId)
  } else {
    console.log('[cleanup] no pinned message present')
  }

  // 2. Sweep message IDs from 1 upward.
  const MAX_ID = 5000
  const BATCH = 100
  let deleted = 0
  let lastProgress = 0
  let emptyStreak = 0

  for (let start = 1; start <= MAX_ID; start += BATCH) {
    const ids: number[] = []
    for (let i = 0; i < BATCH && start + i <= MAX_ID; i++) ids.push(start + i)
    const n = await deleteBatch(ids)
    deleted += n

    if (n === 0) {
      emptyStreak++
      if (emptyStreak >= 10) {
        console.log(`[cleanup] ${emptyStreak * BATCH} consecutive misses — stopping early at id=${start}.`)
        break
      }
    } else {
      emptyStreak = 0
    }

    if (deleted - lastProgress >= 50 || start + BATCH > MAX_ID) {
      console.log(`[cleanup] swept up to id=${start + BATCH - 1}, deleted so far=${deleted}`)
      lastProgress = deleted
    }
  }

  console.log(`[cleanup] DONE. Deleted ${deleted} message(s) from chat ${CHAT_ID}.`)
  console.log('[cleanup] TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID left untouched in .env.')
}

main().catch((err) => {
  console.error('[cleanup] fatal:', err)
  process.exit(1)
})

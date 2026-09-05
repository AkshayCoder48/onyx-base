#!/usr/bin/env bun
/** Direct manifest surgery: remove test files from the usr_2za2wm account
 * manifest in the Telegram durable layer — single-writer, no app instances
 * involved (deterministic, immune to multi-instance last-writer races).
 * Run: bun scripts/surgery-purge-test-files.ts
 */
import { readFileSync } from 'fs'

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
    .filter(([k]) => k && !k.startsWith('#')),
)

const TOKEN = env.TELEGRAM_BOT_TOKEN
const CHAT = env.TELEGRAM_CHAT_ID
const API = (env.TELEGRAM_BOT_API_URL || 'https://api.telegram.org') + `/bot${TOKEN}`
const FILE_BASE = (env.TELEGRAM_BOT_API_URL || 'https://api.telegram.org').replace(/\/$/, '')
const INDEX_MARKER = 'CLOUDKV_ACCOUNT_INDEX_V4'
const MANIFEST_MARKER = 'CLOUDKV_ACCOUNT_MANIFEST_V4'
const TARGET_ACCOUNT = 'usr_2za2wm'
const TEST_RE = /^(chunk2?-test-|plain-|test-)/

async function tg(method: string, params?: Record<string, unknown>) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  })
  return res.json()
}

async function downloadText(fileId: string): Promise<string> {
  const g = await tg('getFile', { file_id: fileId })
  if (!g.ok) throw new Error('getFile failed: ' + g.description)
  const res = await fetch(`${FILE_BASE}/file/bot${TOKEN}/${g.result.file_path}`)
  return res.text()
}

async function main() {
  // 1. Read the pinned V4 index.
  const chat = await tg('getChat', { chat_id: CHAT })
  const pinned = chat.result?.pinned_message
  const pinText = pinned?.text ?? ''
  if (!pinText.startsWith(INDEX_MARKER)) throw new Error('Pinned message is not the V4 account index.')
  const index = JSON.parse(pinText.slice(INDEX_MARKER.length).trim())
  const entry = index.accounts[TARGET_ACCOUNT]
  if (!entry) throw new Error(`No index entry for ${TARGET_ACCOUNT}`)
  console.log(`index pin msg ${pinned.message_id}; account manifest msg ${entry.messageId}, ${entry.bytes}B`)

  // 2. Download + clean the manifest.
  const manifest = JSON.parse(await downloadText(entry.fileId))
  const before = (manifest.files ?? []).length
  manifest.files = (manifest.files ?? []).filter((f: any) => !TEST_RE.test(f?.fileName ?? ''))
  const removed = before - manifest.files.length
  manifest.exportedAt = new Date().toISOString()
  console.log(`files: ${before} → ${manifest.files.length} (removed ${removed})`)
  if (removed === 0) {
    console.log('nothing to remove — already clean.')
    return
  }

  // 3. Send the cleaned manifest (replaces the old message).
  const json = JSON.stringify(manifest)
  const bytes = Buffer.byteLength(json, 'utf8')
  await tg('deleteMessage', { chat_id: CHAT, message_id: entry.messageId })
  const form = new FormData()
  form.append('chat_id', CHAT)
  form.append('document', new Blob([Buffer.from(json, 'utf8')], { type: 'application/json' }), `onyxbase-account-${TARGET_ACCOUNT}.json`)
  form.append('caption', `${MANIFEST_MARKER}\nuserId=${TARGET_ACCOUNT}`.slice(0, 1024))
  form.append('disable_notification', 'true')
  const send = await (await fetch(`${API}/sendDocument`, { method: 'POST', body: form })).json()
  if (!send.ok) throw new Error('sendDocument failed: ' + send.description)
  const newMsg = send.result.message_id
  const newFileId = send.result.document.file_id
  console.log(`new manifest msg ${newMsg}, ${bytes}B`)

  // 4. Update + re-pin the index.
  index.accounts[TARGET_ACCOUNT] = {
    ...entry,
    messageId: newMsg,
    fileId: newFileId,
    bytes,
    updatedAt: new Date().toISOString(),
  }
  index.exportedAt = new Date().toISOString()
  const newText = `${INDEX_MARKER}\n${JSON.stringify(index)}`
  const edit = await tg('editMessageText', {
    chat_id: CHAT,
    message_id: pinned.message_id,
    text: newText,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  })
  if (!edit.ok) throw new Error('editMessageText (index) failed: ' + edit.description)
  console.log('index updated ✓')

  // 5. Verify round-trip.
  const verify = JSON.parse(await downloadText(newFileId))
  const testLeft = (verify.files ?? []).filter((f: any) => TEST_RE.test(f?.fileName ?? '')).length
  console.log(`verify: manifest has ${(verify.files ?? []).length} files, ${testLeft} test files`)
  if (testLeft !== 0) throw new Error('verification failed — test files still present!')
  console.log('✓ SURGERY COMPLETE — durable manifest is clean')
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})

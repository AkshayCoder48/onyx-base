#!/usr/bin/env bun
/** Inspect the Telegram durable layer directly: pinned V4 account index,
 * per-account manifests, and count FileRecords matching test patterns.
 * Run: bun scripts/inspect-durable.ts
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

async function tg(method: string, params?: Record<string, unknown>) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params ?? {}),
  })
  return res.json()
}

async function downloadFile(fileId: string): Promise<string> {
  const g = await tg('getFile', { file_id: fileId })
  if (!g.ok) throw new Error('getFile failed: ' + g.description)
  const base = (env.TELEGRAM_BOT_API_URL || 'https://api.telegram.org').replace(/\/$/, '')
  const res = await fetch(`${base}/file/bot${TOKEN}/${g.result.file_path}`)
  return res.text()
}

function countTestFiles(manifest: any): { files: number; testFiles: string[] } {
  const files = manifest?.files ?? []
  const test = (files as any[]).filter((f) => /^(chunk2?-test-|plain-|test-)/.test(f?.fileName ?? ''))
  return { files: files.length, testFiles: test.map((f) => f.fileName) }
}

async function main() {
  const chat = await tg('getChat', { chat_id: CHAT })
  if (!chat.ok) {
    console.log('getChat failed:', chat.description)
    return
  }
  const pinned = chat.result?.pinned_message
  console.log('pinned message:', pinned ? `msg ${pinned.message_id} (text=${(pinned.text ?? '').length}ch, doc=${pinned.document ? 'yes' : 'no'})` : 'none')
  if (!pinned) return

  // V4 account index is a TEXT message starting with CLOUDKV_ACCOUNT_INDEX_V4.
  const pinText = pinned.text ?? ''
  if (pinText.startsWith('CLOUDKV_ACCOUNT_INDEX_V4')) {
    const parsed = JSON.parse(pinText.slice('CLOUDKV_ACCOUNT_INDEX_V4'.length).trim())
    console.log('V4 account index:', Object.keys(parsed.accounts).join(', '))
    for (const [userId, entry] of Object.entries<any>(parsed.accounts)) {
      console.log(`\naccount ${userId}: msg ${entry.messageId}, ${entry.bytes}B, updated ${entry.updatedAt}`)
      const manifestText = await downloadFile(entry.fileId)
      const manifest = JSON.parse(manifestText)
      const { files, testFiles } = countTestFiles(manifest)
      console.log(`  → files in manifest: ${files}, TEST files: ${testFiles.length}`)
      for (const t of testFiles) console.log(`     · ${t}`)
    }
    return
  }

  // V3 full-state document pin?
  if (pinned.document) {
    const docText = await downloadFile(pinned.document.file_id)
    try {
      const parsed = JSON.parse(docText)
      const { files, testFiles } = countTestFiles(parsed)
      console.log('V3 full-state pin: files:', files, 'TEST files:', testFiles.length)
      for (const t of testFiles) console.log(`  · ${t}`)
    } catch {
      console.log('pinned doc is not JSON — len', docText.length)
    }
    return
  }
  console.log('pin is a plain text message (first 200):', pinText.slice(0, 200))
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})

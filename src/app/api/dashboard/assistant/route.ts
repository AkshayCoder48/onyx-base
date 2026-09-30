/**
 * Onyx Base — Dashboard AI Assistant (POST /api/dashboard/assistant).
 *
 * A tool-calling assistant strictly scoped to the signed-in account.
 * Read tools: stats, collections, records, get_record, files, logs.
 * Write tools: set_record, delete_record — NEVER executed on the first
 * pass. A mutation is returned to the UI as a reviewable "action" and only
 * executes after the user confirms it in the interface (the confirmedAction
 * round-trip), so a hallucinated plan can never destroy data on its own.
 *
 * Tool selection, in order of preference:
 *   1. OPENAI_API_KEY set → an OpenAI-compatible chat-completions planner
 *      (OPENAI_MODEL, default gpt-4o-mini; OPENAI_BASE_URL for another
 *      provider). 9 s timeout; any planner failure falls back to (2). The
 *      key lives server-side only — it is never part of the browser bundle.
 *   2. Deterministic zero-token parser covering the common commands:
 *      "show stats", "list records", "show collections", "show files",
 *      "recent activity", "get record foo", "set foo to 42",
 *      "delete record foo".
 *
 * Guardrails, applied in order before any tool runs:
 *   body size cap → message shape → confirmedAction shape → tool allowlist
 *   → collection/key/value validation → per-key authorize(scope, collection)
 *   → confirmation gate → execution. The per-key policy layer (scopes,
 *   collection allowlists, rate limits) runs on BOTH the planning pass and
 *   the confirmation pass, so a key cannot be escalated mid-conversation.
 *
 * File listings expose metadata only — never Telegram bot credentials and
 * never raw download links. No server-side chat history is kept: each
 * request is stateless and the transcript lives in the browser only.
 */

import { NextRequest } from 'next/server'
import { withApiHandler } from '@/lib/with-api-handler'
import { authorize } from '@/lib/auth'
import { deleteKey, getKeyWithRehydrate, listKeysWithRehydrate, setKey } from '@/lib/kv'
import { getStats, listCollections, listFileRecords, listLogs } from '@/lib/data-store'

export const runtime = 'nodejs'

/* ── Tool registry ──────────────────────────────────────────────────────── */

type Tool =
  | 'stats'
  | 'collections'
  | 'records'
  | 'get_record'
  | 'files'
  | 'logs'
  | 'set_record'
  | 'delete_record'

type Args = { collection?: string; key?: string; value?: unknown; limit?: number }

const TOOL_NAMES: Tool[] = [
  'stats', 'collections', 'records', 'get_record', 'files', 'logs', 'set_record', 'delete_record',
]

const TOOL_DESCRIPTIONS: Record<Tool, string> = {
  stats: 'Get account usage statistics',
  collections: 'List collections and record counts',
  records: 'List recent records in a collection',
  get_record: 'Read one record by key',
  files: 'List file metadata, never expose Telegram credentials or file links',
  logs: 'Show recent activity',
  set_record: 'Create or update a record; requires user confirmation',
  delete_record: 'Delete a record; requires user confirmation',
}

/** Single JSON-schema shape shared by every tool (all fields optional). */
const TOOL_SCHEMA = {
  type: 'object',
  properties: {
    collection: { type: 'string' },
    key: { type: 'string' },
    value: {},
    limit: { type: 'integer' },
  },
  additionalProperties: false,
} as const

/* ── Deterministic fallback planner (no AI key required) ────────────────── */

function localIntent(message: string): { tool?: Tool; args: Args; answer?: string } {
  const text = message.trim()
  const match = (re: RegExp) => text.match(re)
  if (/\b(help|what can you|how to|capabilities)\b/i.test(text)) {
    return {
      args: {},
      answer:
        'I can inspect stats, collections, records, files and activity. Try “list records”, ' +
        '“get record theme”, “set theme to dark”, or “delete record theme”. Changes require your confirmation.',
    }
  }
  const set = match(/^(?:set|save|write|update)\s+(?:record\s+)?([^\s]+)\s+(?:to|=)\s+([\s\S]+)$/i)
  if (set) {
    let value: unknown = set[2]
    try { value = JSON.parse(set[2]) } catch { /* keep the raw string */ }
    return { tool: 'set_record', args: { key: set[1], value } }
  }
  const del = match(/^(?:delete|remove)\s+(?:record\s+)?([^\s]+)$/i)
  if (del) return { tool: 'delete_record', args: { key: del[1] } }
  const get = match(/^(?:get|read|show)\s+(?:record\s+|key\s+)([^\s]+)$/i)
  if (get) return { tool: 'get_record', args: { key: get[1] } }
  if (/\b(collections|buckets)\b/i.test(text)) return { tool: 'collections', args: {} }
  if (/\b(files|uploads|storage)\b/i.test(text)) return { tool: 'files', args: {} }
  if (/\b(logs|activity|events)\b/i.test(text)) return { tool: 'logs', args: {} }
  if (/\b(records|keys|data)\b/i.test(text)) return { tool: 'records', args: {} }
  if (/\b(stats|statistics|overview|usage|status)\b/i.test(text)) return { tool: 'stats', args: {} }
  return {
    args: {},
    answer:
      'Ask me about your stats, collections, records, files or activity. You can also say “set mykey to 42”. ' +
      'Configure OPENAI_API_KEY on the server for natural-language planning.',
  }
}

/* ── Optional AI planner (OpenAI-compatible providers) ──────────────────── */

async function plan(message: string): Promise<{ tool?: Tool; args: Args; answer?: string }> {
  const key = process.env.OPENAI_API_KEY
  if (!key) return localIntent(message)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 9000)
  try {
    const res = await fetch(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 220,
        messages: [
          {
            role: 'system',
            content:
              'You are Onyx Base assistant. Pick exactly one tool if the user asks about their data or wants an action. ' +
              'Never claim an action happened without a tool. Never reveal secrets. If unclear, answer briefly. ' +
              'Mutations require confirmation by the app. Never use tools outside this list.',
          },
          { role: 'user', content: message },
        ],
        tools: TOOL_NAMES.map((name) => ({
          type: 'function',
          function: { name, description: TOOL_DESCRIPTIONS[name], parameters: TOOL_SCHEMA },
        })),
      }),
    })
    if (!res.ok) throw new Error(`Model provider returned ${res.status}`)
    const json = await res.json()
    const choice = json.choices?.[0]?.message
    const call = choice?.tool_calls?.[0]?.function
    if (call && TOOL_NAMES.includes(call.name)) {
      try {
        return { tool: call.name as Tool, args: JSON.parse(call.arguments || '{}') as Args }
      } catch {
        return localIntent(message) // malformed model arguments → safe fallback
      }
    }
    return { args: {}, answer: String(choice?.content || 'How can I help with your workspace?').slice(0, 1200) }
  } catch {
    return localIntent(message) // provider down / timeout → the app still works
  } finally {
    clearTimeout(timer)
  }
}

/* ── Route ──────────────────────────────────────────────────────────────── */

export const POST = withApiHandler({
  operation: 'assistant.chat',
  handler: async (req: NextRequest, ctx) => {
    const user = ctx.user!

    // 1. Body caps — keep the request tiny and parseable.
    if (Number(req.headers.get('content-length') || 0) > 12000) {
      return ctx.fail('Request too large.', 413)
    }
    const body = await req.json().catch(() => null)
    if (!body || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 2000) {
      return ctx.fail('Message must be 1–2000 characters.', 400)
    }

    // 2. Confirmations are accepted only for an action the user selected in
    //    the UI — never synthesized from free text on the same pass.
    const selected = body.confirmedAction
    let intent: { tool?: Tool; args: Args; answer?: string }
    if (selected) {
      if (
        typeof selected !== 'object' ||
        !TOOL_NAMES.includes(selected.tool) ||
        !['set_record', 'delete_record'].includes(selected.tool)
      ) {
        return ctx.fail('Invalid action.', 400)
      }
      intent = { tool: selected.tool, args: selected.args || {} }
    } else {
      intent = await plan(body.message)
    }
    if (!intent.tool) return ctx.ok({ answer: intent.answer || 'How can I help?', action: null })

    // 3. Argument normalization + validation.
    const tool = intent.tool
    const args = intent.args || {}
    const rawCollection = typeof args.collection === 'string' && args.collection ? args.collection : ''
    const collection = rawCollection || 'default'
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(collection)) {
      return ctx.fail('Invalid collection name.', 400)
    }
    const key = typeof args.key === 'string' ? args.key.trim() : ''
    if (['get_record', 'set_record', 'delete_record'].includes(tool) && (!key || key.length > 256)) {
      return ctx.fail('A record key (up to 256 characters) is required.', 400)
    }

    // 4. Per-key policy: write scope for mutations, read scope for queries.
    //    Runs on the planning pass AND again on the confirmation pass.
    const mutating = tool === 'set_record' || tool === 'delete_record'
    const permission = authorize(user, req, {
      scope: mutating ? 'write' : 'read',
      collection: tool === 'records' && !rawCollection ? undefined : collection,
    })
    if (!permission.ok) {
      return ctx.failWithCode(permission.code, permission.message, permission.status)
    }

    // 5. Confirmation gate — mutations never execute on the first pass.
    if (mutating && !selected) {
      return ctx.ok({
        answer: `${tool === 'delete_record' ? 'Delete' : 'Save'} “${key}” in “${collection}”? Review and confirm to continue.`,
        action: { tool, args: { collection, key, ...(tool === 'set_record' ? { value: args.value } : {}) } },
      })
    }
    if (tool === 'set_record' && (args.value === undefined || JSON.stringify(args.value).length > 65536)) {
      return ctx.fail('Value must be valid JSON and under 64 KB.', 400)
    }

    // 6. Execute, strictly scoped to the authenticated account.
    let result: unknown
    switch (tool) {
      case 'stats':
        result = getStats(user.dbUserId)
        break
      case 'collections':
        result = listCollections(user.dbUserId).slice(0, 50)
        break
      case 'records': {
        const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
        result = (await listKeysWithRehydrate(user, rawCollection || undefined)).slice(0, limit)
        break
      }
      case 'get_record':
        result = await getKeyWithRehydrate(user, key, collection)
        break
      case 'files':
        // Metadata only — never bot credentials, never raw download links.
        result = listFileRecords(user.dbUserId)
          .slice(0, 30)
          .map((f) => ({ name: f.fileName, size: f.size, type: f.mimeType, createdAt: f.createdAt }))
        break
      case 'logs':
        result = listLogs(user.dbUserId, { limit: 20 })
          .map((l) => ({ action: l.action, detail: l.detail, createdAt: l.createdAt }))
        break
      case 'set_record':
        ctx.log({ tool, collection, keyBytes: key.length })
        result = await setKey(user, { collection, key, json: args.value, source: 'assistant' })
        break
      case 'delete_record':
        ctx.log({ tool, collection, keyBytes: key.length })
        result = await deleteKey(user, key, collection, 'assistant')
        break
    }

    return ctx.ok({
      answer: mutating
        ? `${tool === 'delete_record' ? 'Deleted' : 'Saved'} “${key}” in “${collection}”.`
        : TOOL_DESCRIPTIONS[tool],
      result,
      action: null,
    })
  },
})

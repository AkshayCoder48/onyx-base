'use client'

/**
 * Onyx Base — Assistant V2 agent loop (100% in-browser).
 *
 * ZERO deployment-provider CPU for intelligence:
 *   - The LLM is called DIRECTLY from the browser (bring-your-own-key,
 *     stored in localStorage, never sent to OnyxBase servers).
 *   - The deterministic fallback planner needs no LLM at all.
 *   - Tool calls hit the same REST endpoints the dashboard UI uses
 *     (read tools mostly serve from the V6 instant cache — no server
 *     round trip at all).
 *
 * Conversation history lives in localStorage only — zero server storage.
 *
 * Mutation safety: write tools NEVER execute during planning. The loop
 * pauses with a `confirm_required` event; the UI shows a review card; only
 * an explicit user confirmation executes the mutation (the confirmed call
 * re-enters the loop with `confirmed: true`).
 */

import { TOOLS, TOOL_BY_NAME, llmToolDescriptors, type ToolArgs, type ToolContext } from '@/lib/v6/tools'

/* ────────────────────────────────────────────────────────────────────────────
 * BYOK LLM configuration (localStorage — client-only, never transmitted)
 * ──────────────────────────────────────────────────────────────────────────── */

export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
}

const LLM_STORE_KEY = 'v6:llm'

export function loadLlmConfig(): LlmConfig | null {
  try {
    const raw = localStorage.getItem(LLM_STORE_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw) as LlmConfig
    if (!cfg?.apiKey || !cfg?.baseUrl || !cfg?.model) return null
    return cfg
  } catch {
    return null
  }
}

export function saveLlmConfig(cfg: LlmConfig | null): void {
  try {
    if (cfg) localStorage.setItem(LLM_STORE_KEY, JSON.stringify(cfg))
    else localStorage.removeItem(LLM_STORE_KEY)
  } catch {
    /* ignore */
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Chat transcript types
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  /** For tool messages: the tool name the result belongs to. */
  toolName?: string
  /** For assistant messages: the pending mutation the user must confirm. */
  pendingAction?: PendingAction
}

export interface PendingAction {
  tool: string
  args: ToolArgs
  /** Remaining tool calls queued after this one (multi-step plans). */
  queue: Array<{ tool: string; args: ToolArgs }>
}

export type AgentEvent =
  | { type: 'tool_started'; name: string; label: string }
  | { type: 'tool_done'; name: string; label: string; result: unknown }
  | { type: 'confirm_required'; action: PendingAction }
  | { type: 'final'; text: string }
  | { type: 'error'; text: string }

const MAX_LLM_ROUNDS = 6
const LLM_TIMEOUT_MS = 30_000

/* ────────────────────────────────────────────────────────────────────────────
 * The OpenAI-compatible browser→provider call
 * ──────────────────────────────────────────────────────────────────────────── */

interface LlmToolCall {
  id: string
  function: { name: string; arguments: string }
}

async function callLlm(
  cfg: LlmConfig,
  messages: Array<Record<string, unknown>>,
): Promise<{ content: string | null; toolCalls: LlmToolCall[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS)
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        max_tokens: 900,
        tools: llmToolDescriptors(),
        messages,
      }),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Model provider returned ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`)
    }
    const json = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string | null; tool_calls?: LlmToolCall[] }
      }>
    }
    const msg = json.choices?.[0]?.message
    return {
      content: typeof msg?.content === 'string' ? msg.content : null,
      toolCalls: Array.isArray(msg?.tool_calls) ? msg.tool_calls : [],
    }
  } finally {
    clearTimeout(timer)
  }
}

const SYSTEM_PROMPT = `You are the Onyx Base assistant, embedded in the user's dashboard. You manage their entire workspace through tools: records (KV data), collections, API keys, share tokens, files, email, analytics, logs, diagnostics, and navigation.

Rules:
- Use tools for every factual answer about the account — never invent data.
- Multiple tool calls in one turn are allowed; batch reads when useful.
- Mutating tools (set_record, delete_record, create_*, revoke_*, delete_*, send_email) are ALWAYS intercepted by the app for user confirmation — call them freely and let the app handle approval.
- After tools complete you get their results — then answer concisely with the facts.
- Never reveal API keys, bot tokens, or credentials.
- Keep answers short and practical. Use markdown-ish plain text.`

/* ────────────────────────────────────────────────────────────────────────────
 * Deterministic fallback planner (zero-LLM mode) — full catalog grammar
 * ──────────────────────────────────────────────────────────────────────────── */

export interface Plan {
  tool?: string
  args: ToolArgs
  answer?: string
}

export function localPlan(input: string): Plan {
  const text = input.trim()
  const m = (re: RegExp) => text.match(re)

  if (/\b(help|what can you do|capabilities)\b/i.test(text)) {
    return {
      args: {},
      answer:
        'I manage your whole workspace: records, collections, API keys, share tokens, files, email, analytics, logs and navigation. ' +
        'Try: “show stats” · “list records” · “get record theme” · “set theme to dark” · “delete record theme” · ' +
        '“create collection cache” · “create api key ci-bot” · “list share tokens” · “send email via personal_email to a@b.com” · ' +
        '“open the analytics tab”. Changes always require your confirmation. Connect an OpenAI-compatible key in Assistant settings for free-form planning.',
    }
  }

  // Navigation
  const nav = m(/^(?:open|go to|show me|switch to|navigate to)\s+(?:the\s+)?([a-z-]+)(?:\s+(?:tab|page|view))?$/i)
  if (nav) {
    const view = nav[1].toLowerCase().replace(/\s+/g, '-')
    const canon: Record<string, string> = {
      home: 'overview', dashboard: 'overview', main: 'overview',
      db: 'database', data: 'database', records: 'database', kv: 'database',
      storage: 'storage', files: 'storage', uploads: 'storage',
      keys: 'api-keys', 'api keys': 'api-keys', 'api-keys': 'api-keys',
      email: 'email-automation', 'email-automation': 'email-automation',
      share: 'share', sharing: 'share', tokens: 'share',
      logs: 'logs', activity: 'logs',
      analytics: 'analytics', charts: 'analytics',
      playground: 'playground', docs: 'docs', documentation: 'docs',
      settings: 'settings', diagnostics: 'diagnostics',
    }
    const mapped = canon[view] ?? view
    return { tool: 'navigate', args: { view: mapped } }
  }

  // Records mutations
  const set = m(/^(?:set|save|write|update)\s+(?:record\s+|key\s+)?([^\s]+)(?:\s+(?:in|to|into)\s+([A-Za-z_][A-Za-z0-9_-]*))?\s+(?:to|=)\s+([\s\S]+)$/i)
  if (set) {
    let value: unknown = set[3]
    try { value = JSON.parse(set[3]) } catch { /* raw string */ }
    return { tool: 'set_record', args: { key: set[1], ...(set[2] ? { collection: set[2] } : {}), value } }
  }
  const delRec = m(/^(?:delete|remove)\s+(?:record\s+|key\s+)?([^\s]+)(?:\s+(?:from|in)\s+([A-Za-z_][A-Za-z0-9_-]*))?$/i)
  if (delRec && !/collection/i.test(text) && !/api\s*key/i.test(text) && !/token/i.test(text) && !/file/i.test(text)) {
    return { tool: 'delete_record', args: { key: delRec[1], ...(delRec[2] ? { collection: delRec[2] } : {}) } }
  }
  const getRec = m(/^(?:get|read|show)\s+(?:record\s+|key\s+|value\s+of\s+)([^\s]+)(?:\s+(?:from|in)\s+([A-Za-z_][A-Za-z0-9_-]*))?$/i)
  if (getRec) return { tool: 'get_record', args: { key: getRec[1], ...(getRec[2] ? { collection: getRec[2] } : {}) } }

  // Collection mutations
  const createCol = m(/^(?:create|make|new)\s+collection\s+([A-Za-z_][A-Za-z0-9_-]*)$/i)
  if (createCol) return { tool: 'create_collection', args: { name: createCol[1] } }
  const delCol = m(/^(?:delete|remove)\s+collection\s+([A-Za-z_][A-Za-z0-9_-]*)$/i)
  if (delCol) return { tool: 'delete_collection', args: { name: delCol[1] } }

  // API keys
  const createKey = m(/^(?:create|mint|new)\s+(?:api[- ]?key)\s+(?:named\s+|called\s+)?([A-Za-z0-9_][A-Za-z0-9_-]*)/i)
  if (createKey) return { tool: 'create_api_key', args: { name: createKey[1] } }
  const revokeKey = m(/^(?:revoke|delete|remove)\s+(?:api[- ]?key)\s+(\S+)$/i)
  if (revokeKey) return { tool: 'revoke_api_key', args: { id: revokeKey[1] } }

  // Share tokens
  const createShare = m(/^(?:create|mint|new)\s+(?:a\s+)?(?:public\s+)?share\s+token\s+(?:for\s+)?([^\s]+)(?:\s+(?:with|in)\s+mode\s+(read|write|readwrite))?/i)
  if (createShare) return { tool: 'create_share_token', args: { key: createShare[1], mode: createShare[2] || 'read' } }
  const revokeShare = m(/^(?:revoke|delete|remove)\s+(?:share\s+)?token\s+(\S+)$/i)
  if (revokeShare) return { tool: 'revoke_share_token', args: { id: revokeShare[1] } }

  // Files
  const revokeLink = m(/^(?:revoke|kill)\s+(?:the\s+)?(?:public\s+)?(?:link|url)\s+(?:of|for)\s+(?:file\s+)?(\S+)$/i)
  if (revokeLink) return { tool: 'revoke_file_link', args: { id: revokeLink[1] } }
  const delFile = m(/^(?:delete|remove)\s+file\s+(\S+)$/i)
  if (delFile) return { tool: 'delete_file', args: { id: delFile[1] } }

  // Email
  const sendEmail = m(/^(?:send|write)\s+(?:an\s+)?email\s+(?:via|using|from)\s+([A-Za-z0-9_-]+)\s+to\s+(\S+@\S+)\s*(?:saying|with subject)?\s*([\s\S]*)$/i)
  if (sendEmail) {
    return {
      tool: 'send_email',
      args: {
        credential: sendEmail[1],
        to: sendEmail[2],
        subject: 'Message from Onyx Base',
        body: sendEmail[3]?.trim() || '(empty message)',
      },
    }
  }

  // Reads
  if (/\b(api[- ]?keys?)\b/i.test(text) && /\b(list|show|my|all)\b/i.test(text)) return { tool: 'api_keys', args: {} }
  if (/\b(share\s*tokens?|public\s*tokens?)\b/i.test(text)) return { tool: 'share_tokens', args: {} }
  if (/\b(files?|uploads?|storage)\b/i.test(text)) return { tool: 'files', args: {} }
  if (/\b(credential|email)\b/i.test(text) && /\b(list|show|connected)\b/i.test(text)) return { tool: 'email_credentials', args: {} }
  if (/\b(logs?|activity|events|history)\b/i.test(text)) return { tool: 'logs', args: {} }
  if (/\b(analytics|breakdown|by collection|by type|top keys)\b/i.test(text)) return { tool: 'analytics', args: {} }
  if (/\b(diagnostics|queue|sync)\b/i.test(text)) return { tool: 'diagnostics', args: {} }
  if (/\b(telegram|backup|channel)\b/i.test(text)) return { tool: 'telegram_status', args: {} }
  if (/\b(collections?|buckets?)\b/i.test(text)) return { tool: 'collections', args: {} }
  if (/\b(records?|keys?|data|entries)\b/i.test(text)) return { tool: 'records', args: {} }
  if (/\b(stats?|statistics|overview|usage|how many|status)\b/i.test(text)) return { tool: 'stats', args: {} }

  return {
    args: {},
    answer:
      'I can manage records, collections, API keys, share tokens, files, email, analytics and navigation — say “help” for examples. ' +
      'For free-form natural language, connect an OpenAI-compatible key in the Assistant settings (⚙) — it runs in your browser only.',
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * The agent turn
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TurnRequest {
  message: string
  history: ChatMessage[]
  llm: LlmConfig | null
  ctx: ToolContext
  /** When set, this turn EXECUTES a previously confirmed mutation. */
  confirmed?: PendingAction
  onEvent: (e: AgentEvent) => void
}

export interface TurnResult {
  history: ChatMessage[]
  pending: PendingAction | null
  finalText: string
}

export async function runAgentTurn(req: TurnRequest): Promise<TurnResult> {
  const history: ChatMessage[] = [...req.history, { role: 'user', content: req.message }]
  const ctx = req.ctx

  /* ── Confirmed-mutation execution pass ─────────────────────────────────── */
  if (req.confirmed) {
    const { tool, args, queue } = req.confirmed
    const spec = TOOL_BY_NAME.get(tool)
    if (!spec) throw new Error(`Unknown tool “${tool}”.`)
    const label = spec.label(args)
    req.onEvent({ type: 'tool_started', name: tool, label })
    let result: unknown
    try {
      result = await spec.run(args, ctx)
    } catch (err) {
      const text = err instanceof Error ? err.message : 'execution failed'
      history.push({ role: 'tool', toolName: tool, content: `ERROR: ${text}` })
      req.onEvent({ type: 'error', text })
      return { history, pending: null, finalText: `Failed: ${text}` }
    }
    history.push({ role: 'tool', toolName: tool, content: summarize(result) })
    req.onEvent({ type: 'tool_done', name: tool, label, result })

    // Continue the remaining queue (next write may pause for confirmation).
    if (queue.length > 0) {
      const [next, ...rest] = queue
      const nextSpec = TOOL_BY_NAME.get(next.tool)
      if (nextSpec?.category === 'write') {
        const pending: PendingAction = { tool: next.tool, args: next.args, queue: rest }
        history.push({
          role: 'assistant',
          content: `Next step needs your approval: ${nextSpec.label(next.args)}`,
          pendingAction: pending,
        })
        req.onEvent({ type: 'confirm_required', action: pending })
        return { history, pending, finalText: '' }
      }
      // read/action tool — execute inline
      const label2 = nextSpec?.label(next.args) ?? next.tool
      req.onEvent({ type: 'tool_started', name: next.tool, label: label2 })
      try {
        const r2 = await nextSpec?.run(next.args, ctx)
        history.push({ role: 'tool', toolName: next.tool, content: summarize(r2) })
        req.onEvent({ type: 'tool_done', name: next.tool, label: label2, result: r2 })
      } catch (err) {
        history.push({ role: 'tool', toolName: next.tool, content: `ERROR: ${(err as Error).message}` })
      }
    }

    const finalText = req.llm
      ? await summarizeWithLlm(req.llm, history, req.onEvent)
      : `${label} — done.`
    history.push({ role: 'assistant', content: finalText })
    req.onEvent({ type: 'final', text: finalText })
    return { history, pending: null, finalText }
  }

  /* ── Planning pass ─────────────────────────────────────────────────────── */
  if (!req.llm) {
    const plan = localPlan(req.message)
    if (!plan.tool) {
      history.push({ role: 'assistant', content: plan.answer || 'How can I help?' })
      req.onEvent({ type: 'final', text: plan.answer || 'How can I help?' })
      return { history, pending: null, finalText: plan.answer || 'How can I help?' }
    }
    const spec = TOOL_BY_NAME.get(plan.tool)
    if (!spec) throw new Error(`Unknown tool “${plan.tool}”.`)
    if (spec.category === 'write') {
      const pending: PendingAction = { tool: plan.tool, args: plan.args, queue: [] }
      history.push({
        role: 'assistant',
        content: `Your approval is required: ${spec.label(plan.args)}`,
        pendingAction: pending,
      })
      req.onEvent({ type: 'confirm_required', action: pending })
      return { history, pending, finalText: '' }
    }
    const label = spec.label(plan.args)
    req.onEvent({ type: 'tool_started', name: plan.tool, label })
    const result = await spec.run(plan.args, ctx)
    history.push({ role: 'tool', toolName: plan.tool, content: summarize(result) })
    req.onEvent({ type: 'tool_done', name: plan.tool, label, result })
    const finalText = `${label}: ${summarize(result)}`
    history.push({ role: 'assistant', content: finalText })
    req.onEvent({ type: 'final', text: finalText })
    return { history, pending: null, finalText }
  }

  /* ── LLM multi-turn tool-calling loop ──────────────────────────────────── */
  const llmMessages: Array<Record<string, unknown>> = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.map((m) => ({ role: m.role, content: m.content })),
  ]

  for (let round = 0; round < MAX_LLM_ROUNDS; round++) {
    let response: { content: string | null; toolCalls: LlmToolCall[] }
    try {
      response = await callLlm(req.llm, llmMessages)
    } catch (err) {
      // Provider failure → deterministic fallback so the app still works.
      const plan = localPlan(req.message)
      const text = `LLM unavailable (${err instanceof Error ? err.message : 'network error'}) — used the built-in planner. ${
        plan.answer ?? (plan.tool ? `Planned: ${plan.tool}.` : '')
      }`
      history.push({ role: 'assistant', content: text })
      req.onEvent({ type: 'error', text })
      return { history, pending: null, finalText: text }
    }

    if (response.toolCalls.length === 0) {
      const finalText = response.content?.trim() || 'Done.'
      history.push({ role: 'assistant', content: finalText })
      req.onEvent({ type: 'final', text: finalText })
      return { history, pending: null, finalText }
    }

    // Process tool calls in order; a WRITE pauses the loop for confirmation.
    const assistantMsg: Record<string, unknown> = {
      role: 'assistant',
      content: response.content ?? '',
      tool_calls: response.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: c.function,
      })),
    }
    llmMessages.push(assistantMsg)

    for (let i = 0; i < response.toolCalls.length; i++) {
      const call = response.toolCalls[i]
      const spec = TOOL_BY_NAME.get(call.function.name)
      let args: ToolArgs
      try {
        args = JSON.parse(call.function.arguments || '{}') as ToolArgs
      } catch {
        args = {}
      }
      if (!spec) {
        llmMessages.push({ role: 'tool', tool_call_id: call.id, content: `ERROR: unknown tool ${call.function.name}` })
        continue
      }

      if (spec.category === 'write') {
        // Pause for confirmation; the REMAINING calls (this one + later ones)
        // form the queue that resumes after approval.
        const remaining = response.toolCalls.slice(i).map((c) => {
          let a: ToolArgs = {}
          try { a = JSON.parse(c.function.arguments || '{}') as ToolArgs } catch { /* empty */ }
          return { tool: c.function.name, args: a }
        })
        const [head, ...tail] = remaining
        const pending: PendingAction = { tool: head.tool, args: head.args, queue: tail }
        history.push({
          role: 'assistant',
          content: `Your approval is required: ${spec.label(head.args)}`,
          pendingAction: pending,
        })
        req.onEvent({ type: 'confirm_required', action: pending })
        return { history, pending, finalText: '' }
      }

      const label = spec.label(args)
      req.onEvent({ type: 'tool_started', name: spec.name, label })
      try {
        const result = await spec.run(args, ctx)
        llmMessages.push({ role: 'tool', tool_call_id: call.id, content: summarize(result) })
        history.push({ role: 'tool', toolName: spec.name, content: summarize(result) })
        req.onEvent({ type: 'tool_done', name: spec.name, label, result })
      } catch (err) {
        const text = err instanceof Error ? err.message : 'tool failed'
        llmMessages.push({ role: 'tool', tool_call_id: call.id, content: `ERROR: ${text}` })
        history.push({ role: 'tool', toolName: spec.name, content: `ERROR: ${text}` })
      }
    }
    // Loop continues — the LLM sees the tool results and answers.
  }

  const finalText = 'Reached the tool-call limit for one turn — split the request into smaller steps.'
  history.push({ role: 'assistant', content: finalText })
  req.onEvent({ type: 'final', text: finalText })
  return { history, pending: null, finalText }
}

/** After a confirmed mutation (with LLM), produce a natural-language wrap-up. */
async function summarizeWithLlm(
  llm: LlmConfig,
  history: ChatMessage[],
  onEvent: (e: AgentEvent) => void,
): Promise<string> {
  try {
    const res = await callLlm(llm, [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((m) => ({ role: m.role, content: m.content })),
    ])
    const text = res.content?.trim()
    if (text) return text
  } catch (err) {
    onEvent({ type: 'error', text: `Summary skipped: ${err instanceof Error ? err.message : 'LLM error'}` })
  }
  return 'Done.'
}

/** Compact JSON summary for transcript/tool messages (capped). */
function summarize(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? 'null'
    return json.length > 2200 ? `${json.slice(0, 2200)}\n… (truncated)` : json
  } catch {
    return String(value)
  }
}

export const AGENT_TOOL_NAMES = TOOLS.map((t) => t.name)

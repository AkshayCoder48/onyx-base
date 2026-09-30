'use client'

/**
 * Onyx Base — Assistant V2 (V6 Ultima, 100% client-side).
 *
 * The agent loop runs IN THE BROWSER (see lib/v6/agent.ts): zero
 * deployment-provider CPU for intelligence, zero server-side storage for
 * the transcript. Tools manage the ENTIRE app — records, collections,
 * API keys, share tokens, files, email, analytics, logs, diagnostics and
 * navigation — via the same REST endpoints the dashboard itself uses
 * (read tools prefer the V6 instant cache).
 *
 * An optional bring-your-own-key LLM (OpenAI-compatible) unlocks free-form
 * planning; the key lives in localStorage and is sent ONLY to the model
 * provider, never to OnyxBase servers. Without a key, the built-in
 * deterministic planner covers the full command grammar.
 *
 * Mutations NEVER execute during planning — every write surfaces a review
 * card and only runs after explicit confirmation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import {
  Bot, Sparkles, ArrowUp, Database, FolderOpen, Activity, HardDrive, KeyRound,
  Share2, Mail, Compass, ShieldCheck, Loader2, Check, X, RotateCcw, Settings2,
  Zap, Cpu,
} from 'lucide-react'
import { useApi } from '@/lib/api'
import { useOnyxBase, type ViewKey } from '@/lib/store'
import {
  runAgentTurn, loadLlmConfig, saveLlmConfig,
  type ChatMessage, type PendingAction, type AgentEvent, type LlmConfig,
} from '@/lib/v6/agent'
import { TOOL_BY_NAME, type ToolContext } from '@/lib/v6/tools'

/* ── Display message model (extends the agent transcript with UI extras) ── */

interface DisplayMessage {
  id: string
  kind: 'user' | 'assistant' | 'tool' | 'error'
  text: string
  toolName?: string
  label?: string
  result?: unknown
  running?: boolean
  pendingAction?: PendingAction
}

const PROMPTS = [
  { icon: Activity, title: 'Workspace overview', prompt: 'Show my stats', subtitle: 'Records, storage & usage' },
  { icon: Database, title: 'Browse records', prompt: 'List records', subtitle: 'Explore your data' },
  { icon: KeyRound, title: 'Mint an API key', prompt: 'Create api key ci-bot', subtitle: 'Scoped, revocable access' },
  { icon: Share2, title: 'Share a record', prompt: 'Create share token for leaderboard', subtitle: 'Public read access' },
  { icon: Mail, title: 'Send an email', prompt: 'List email credentials', subtitle: 'Connected senders' },
  { icon: Compass, title: 'Navigate', prompt: 'Open the analytics tab', subtitle: 'Jump anywhere instantly' },
]

const CHAT_KEY = (userId: string) => `v6:chat:${userId}`

let idCounter = 0
const nextId = () => `m${Date.now().toString(36)}${(idCounter++).toString(36)}`

export function AssistantView() {
  const api = useApi()
  const qc = useQueryClient()
  const apiKey = useOnyxBase((s) => s.apiKey)
  const userId = useOnyxBase((s) => s.user?.userId)
  const setView = useOnyxBase((s) => s.setView)

  const [display, setDisplay] = useState<DisplayMessage[]>([])
  const [agentHistory, setAgentHistory] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [llm, setLlm] = useState<LlmConfig | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)

  /* ── persistence (client-only — zero server storage) ── */
  const chatStoreKey = userId ? CHAT_KEY(userId) : null
  useEffect(() => {
    setLlm(loadLlmConfig())
    if (!chatStoreKey) return
    try {
      const raw = localStorage.getItem(chatStoreKey)
      if (raw) {
        const saved = JSON.parse(raw) as { display?: DisplayMessage[]; history?: ChatMessage[] }
        if (Array.isArray(saved.display)) {
          // Any persisted pending action is stale across reloads — drop it.
          setDisplay(saved.display.map((m) => ({ ...m, running: false, pendingAction: undefined })))
        }
        if (Array.isArray(saved.history)) setAgentHistory(saved.history)
      }
    } catch { /* fresh start */ }
  }, [chatStoreKey])

  useEffect(() => {
    if (!chatStoreKey || display.length === 0) return
    try {
      localStorage.setItem(chatStoreKey, JSON.stringify({
        display: display.slice(-80),
        history: agentHistory.slice(-40),
      }))
    } catch { /* quota — best effort */ }
  }, [display, agentHistory, chatStoreKey])

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [display, busy])

  const toolCtx = useMemo<ToolContext>(() => ({
    api,
    apiKey: apiKey ?? '',
    qc,
    navigate: (view: ViewKey) => setView(view),
  }), [api, apiKey, qc, setView])

  const appendEvent = useCallback((e: AgentEvent) => {
    setDisplay((prev) => {
      switch (e.type) {
        case 'tool_started':
          return [...prev, { id: nextId(), kind: 'tool', text: '', toolName: e.name, label: e.label, running: true }]
        case 'tool_done': {
          // Resolve the newest "running" chip of this tool in place instead
          // of stacking a second chip.
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i]
            if (m.kind === 'tool' && m.running && m.toolName === e.name) {
              const copy = [...prev]
              copy[i] = { ...m, running: false, result: e.result }
              return copy
            }
          }
          // no running chip found (e.g. history was trimmed) — append a done chip
          return [...prev, { id: nextId(), kind: 'tool', text: '', toolName: e.name, label: e.label, result: e.result }]
        }
        case 'confirm_required':
          return [...prev, {
            id: nextId(), kind: 'assistant', text: 'Your approval is required:',
            label: TOOL_BY_NAME.get(e.action.tool)?.label(e.action.args) ?? e.action.tool,
            pendingAction: e.action,
          }]
        case 'error':
          return [...prev, { id: nextId(), kind: 'error', text: e.text }]
        case 'final':
          return [...prev, { id: nextId(), kind: 'assistant', text: e.text }]
      }
    })
  }, [])

  const send = useCallback(async (text: string, confirmed?: PendingAction) => {
    if (busy) return
    if (!text.trim() && !confirmed) return
    setBusy(true)
    if (!confirmed) {
      setInput('')
      setDisplay((prev) => [...prev, { id: nextId(), kind: 'user', text: text.trim() }])
    } else {
      // Clear every pending card — one reviewable action at a time.
      setDisplay((prev) => prev.map((m) => (m.pendingAction ? { ...m, pendingAction: undefined } : m)))
    }
    try {
      const result = await runAgentTurn({
        message: confirmed ? 'Confirmed.' : text.trim(),
        history: agentHistory,
        llm,
        ctx: toolCtx,
        confirmed,
        onEvent: appendEvent,
      })
      setAgentHistory(result.history.slice(-40))
    } catch (err) {
      setDisplay((prev) => [...prev, {
        id: nextId(), kind: 'error',
        text: err instanceof Error ? err.message : 'Something went wrong. Please retry.',
      }])
    } finally {
      setBusy(false)
      field.current?.focus()
    }
  }, [agentHistory, busy, llm, toolCtx, appendEvent])

  function cancelPending(id: string) {
    setDisplay((prev) => prev.map((m) => (m.id === id ? { ...m, pendingAction: undefined } : m)))
  }

  function newChat() {
    setDisplay([])
    setAgentHistory([])
    if (chatStoreKey) {
      try { localStorage.removeItem(chatStoreKey) } catch { /* ignore */ }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

  return (
    <div className="assistant-workspace -my-6 lg:-my-8 flex min-h-[calc(100dvh-172px)] flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between gap-3 border-b border-white/60 py-5">
        <div className="flex items-center gap-3">
          <div className="assistant-icon grid size-11 place-items-center rounded-2xl"><Sparkles size={20} /></div>
          <div>
            <h2 className="text-base font-semibold tracking-tight">Onyx Assistant</h2>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Zap size={11} className="text-[#f2521b]" />
              V6 Ultima · runs in your browser
              {llm ? (
                <span className="assistant-llm-badge inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium">
                  <Cpu size={10} /> {llm.model}
                </span>
              ) : (
                <span className="text-muted-foreground/60">· built-in planner</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setSettingsOpen((v) => !v)}
            className="assistant-clear flex items-center gap-2 rounded-xl px-3 py-2 text-xs"
            aria-label="Assistant settings"
            aria-expanded={settingsOpen}
          >
            <Settings2 size={13} /> <span className="hidden sm:inline">AI settings</span>
          </button>
          {display.length > 0 && (
            <button onClick={newChat} className="assistant-clear flex items-center gap-2 rounded-xl px-3 py-2 text-xs" aria-label="Clear conversation">
              <RotateCcw size={13} /> <span className="hidden sm:inline">New chat</span>
            </button>
          )}
        </div>
      </div>

      {/* ── BYOK settings panel ── */}
      {settingsOpen && (
        <LlmSettings
          current={llm}
          onSave={(cfg) => { saveLlmConfig(cfg); setLlm(cfg); setSettingsOpen(false) }}
          onClear={() => { saveLlmConfig(null); setLlm(null) }}
        />
      )}

      {/* ── Transcript / empty state ── */}
      <div className="flex-1 space-y-5 overflow-y-auto scroll-slim py-7" aria-live="polite">
        {display.length === 0 ? (
          <div className="assistant-welcome mx-auto flex max-w-2xl flex-col items-center pt-8 text-center sm:pt-16">
            <div className="assistant-orb mb-6 grid size-20 place-items-center rounded-[26px]"><Bot size={34} strokeWidth={1.6} /></div>
            <span className="assistant-eyebrow mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em]">
              <span className="size-1.5 rounded-full bg-[#c9a227]" /> V6 Ultima · zero-server intelligence
            </span>
            <h3 className="assistant-heading text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">
              What can I help you <em className="not-italic">manage?</em>
            </h3>
            <p className="mt-4 max-w-md text-sm leading-7 text-muted-foreground">
              Your entire workspace as tools — records, keys, tokens, files, email, navigation. Changes always need your approval.
            </p>
            <div className="mt-10 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-2">
              {PROMPTS.map(({ icon: Icon, title, subtitle, prompt }, i) => (
                <button
                  key={title}
                  onClick={() => void send(prompt)}
                  className="assistant-prompt group flex items-center gap-4 rounded-2xl p-4 text-left"
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <span className="assistant-prompt-icon grid size-10 shrink-0 place-items-center rounded-xl"><Icon size={17} /></span>
                  <span className="flex-1">
                    <strong className="block text-sm font-medium">{title}</strong>
                    <small className="mt-0.5 block text-xs text-muted-foreground">{subtitle}</small>
                  </span>
                  <ArrowUp size={15} className="rotate-45 opacity-40 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-3xl space-y-5 pb-6">
            {display.map((message) => {
              if (message.kind === 'user') {
                return (
                  <div key={message.id} className="assistant-message flex justify-end">
                    <div className="assistant-user max-w-[min(85%,680px)] rounded-2xl rounded-tr-sm px-4 py-3 text-sm">{message.text}</div>
                  </div>
                )
              }
              if (message.kind === 'tool') {
                return (
                  <div key={message.id} className="assistant-message flex items-center gap-3">
                    <span className="assistant-tool-chip inline-flex items-center gap-2 rounded-full px-3 py-1.5 font-mono text-[11px]">
                      {message.running ? <Loader2 className="size-3 animate-spin" /> : <Check className="size-3" />}
                      {message.toolName}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">{message.label}</span>
                  </div>
                )
              }
              // assistant / error
              return (
                <div key={message.id} className="assistant-message flex gap-3">
                  <div className="assistant-icon grid size-8 shrink-0 place-items-center rounded-xl"><Sparkles size={15} /></div>
                  <div className="min-w-0 flex-1 space-y-3">
                    <p className={`text-sm leading-7 ${message.kind === 'error' ? 'text-[#e5484d]' : ''}`}>{message.text}</p>
                    {message.label && message.kind === 'assistant' && (
                      <p className="font-mono text-xs text-[#b0430f]">{message.label}</p>
                    )}
                    {message.result !== undefined && message.result !== null && (
                      <pre className="assistant-result max-h-80 overflow-auto rounded-xl p-4 text-left font-mono text-xs leading-6">
                        {JSON.stringify(message.result, null, 2)}
                      </pre>
                    )}
                    {message.pendingAction && (
                      <div className="assistant-confirm rounded-2xl p-4">
                        <div className="mb-3 flex items-center gap-2 text-xs font-semibold"><ShieldCheck size={16} /> Your approval is required</div>
                        <div className="mb-4 break-all font-mono text-xs opacity-75">
                          {message.pendingAction.tool} · {message.label}
                        </div>
                        <div className="flex gap-2">
                          <button
                            className="assistant-approve inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold"
                            disabled={busy}
                            onClick={() => void send('Confirmed.', message.pendingAction)}
                          >
                            <Check size={14} /> Confirm
                          </button>
                          <button
                            className="assistant-clear inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs"
                            onClick={() => cancelPending(message.id)}
                          >
                            <X size={14} /> Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
            {busy && display[display.length - 1]?.kind === 'user' && (
              <div className="assistant-message flex items-center gap-2 pl-11 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> working…
              </div>
            )}
            <div ref={end} />
          </div>
        )}
      </div>

      {/* ── Composer ── */}
      <div className="assistant-compose pb-6 pt-2">
        <div className="mx-auto max-w-3xl">
          <div className="assistant-input flex items-end gap-2 rounded-2xl p-2 pl-4">
            <textarea
              ref={field}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Ask, inspect, or manage anything — try “help”"
              aria-label="Message the assistant"
              className="max-h-36 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground/60"
            />
            <button
              onClick={() => void send(input)}
              disabled={busy || !input.trim()}
              className="assistant-send grid size-10 shrink-0 place-items-center rounded-xl transition-all disabled:opacity-40"
              aria-label="Send message"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp size={17} />}
            </button>
          </div>
          <p className="mt-2 text-center text-[11px] text-muted-foreground/70">
            {llm
              ? `LLM called directly from your browser (${llm.model}) — OnyxBase servers do no AI work.`
              : 'Built-in deterministic planner active — add an AI key in settings for free-form planning.'}
          </p>
        </div>
      </div>
    </div>
  )
}

/* ── BYOK settings panel ─────────────────────────────────────────────────── */

function LlmSettings({
  current, onSave, onClear,
}: {
  current: LlmConfig | null
  onSave: (cfg: LlmConfig) => void
  onClear: () => void
}) {
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? 'https://api.openai.com/v1')
  const [model, setModel] = useState(current?.model ?? 'gpt-4o-mini')
  const [apiKey, setApiKey] = useState(current?.apiKey ?? '')

  return (
    <div className="assistant-settings rounded-2xl p-5">
      <div className="mb-4">
        <h3 className="text-sm font-semibold">AI planner (bring your own key)</h3>
        <p className="mt-1 text-xs leading-6 text-muted-foreground">
          Any OpenAI-compatible endpoint works (OpenAI, OpenRouter, Groq, LM Studio…). The key is stored in
          your browser only and is sent <strong>directly to the provider</strong> — OnyxBase servers never see
          it and never run AI for you. Without a key, the built-in deterministic planner handles everything.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Base URL</span>
          <input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
            className="h-9 w-full rounded-lg border border-black/10 bg-white/70 px-3 font-mono text-xs outline-none focus:border-[#f2521b]/50"
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="gpt-4o-mini"
            className="h-9 w-full rounded-lg border border-black/10 bg-white/70 px-3 font-mono text-xs outline-none focus:border-[#f2521b]/50"
            spellCheck={false}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">API key</span>
          <input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            type="password"
            placeholder="sk-…"
            className="h-9 w-full rounded-lg border border-black/10 bg-white/70 px-3 font-mono text-xs outline-none focus:border-[#f2521b]/50"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          className="assistant-approve inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold"
          disabled={!apiKey.trim() || !baseUrl.trim() || !model.trim()}
          onClick={() => onSave({ baseUrl: baseUrl.trim(), model: model.trim(), apiKey: apiKey.trim() })}
        >
          <Check size={14} /> Save key
        </button>
        {current && (
          <button className="assistant-clear inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs" onClick={onClear}>
            <X size={14} /> Remove key
          </button>
        )}
      </div>
    </div>
  )
}

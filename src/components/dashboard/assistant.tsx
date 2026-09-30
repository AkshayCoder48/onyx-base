'use client'

/**
 * Onyx Base — Dashboard AI Assistant view.
 *
 * Chat surface for /api/dashboard/assistant. The transcript lives in this
 * component's state only (no server-side history). Mutations come back from
 * the API as a reviewable `action`; nothing is written until the user
 * presses Confirm, and the confirmation re-runs the server-side policy
 * checks before executing.
 */

import { useState, useRef, useEffect, useTransition } from 'react'
import { Bot, Sparkles, ArrowUp, Database, FolderOpen, Activity, HardDrive, ShieldCheck, Loader2, Check, X, RotateCcw } from 'lucide-react'
import { useApi } from '@/lib/api'

type Action = { tool: string; args: { collection?: string; key?: string; value?: unknown } }
type Message = { role: 'assistant' | 'user'; text: string; result?: unknown; action?: Action | null; error?: boolean }
type Reply = { answer: string; result?: unknown; action?: Action | null; error?: string }

/* ── Starter prompts shown on the empty state ── */
const PROMPTS = [
  { icon: Activity, title: 'Workspace overview', prompt: 'Show my stats', subtitle: 'Records, storage & usage' },
  { icon: Database, title: 'Browse records', prompt: 'List records', subtitle: 'Explore your data' },
  { icon: FolderOpen, title: 'Collections', prompt: 'Show collections', subtitle: 'Organize your workspace' },
  { icon: HardDrive, title: 'Cloud files', prompt: 'Show files', subtitle: 'View stored uploads' },
]

export function AssistantView() {
  const call = useApi()
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()
  const end = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { end.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }) }, [messages, busy])

  async function send(text: string, confirmedAction?: Action) {
    if (!text.trim() || busy) return
    setBusy(true)
    setInput('')
    if (!confirmedAction) setMessages(previous => [...previous, { role: 'user', text }])
    try {
      const response = await call<Reply>('/api/dashboard/assistant', {
        method: 'POST',
        body: JSON.stringify({ message: text, ...(confirmedAction ? { confirmedAction } : {}) }),
      })
      startTransition(() => setMessages(previous => [
        // Clear any other pending confirmation — one reviewable action at a time.
        ...previous.map(m => m.action ? { ...m, action: null } : m),
        { role: 'assistant', text: response.answer, result: response.result, action: response.action },
      ]))
    } catch (error) {
      setMessages(previous => [...previous, {
        role: 'assistant',
        text: error instanceof Error ? error.message : 'Something went wrong. Please retry.',
        error: true,
      }])
    } finally {
      setBusy(false)
      field.current?.focus()
    }
  }

  return (
    <div className="assistant-workspace -my-6 lg:-my-8 flex min-h-[calc(100dvh-172px)] flex-col">
      {/* ── Header ── */}
      <div className="flex items-center justify-between border-b border-white/60 py-5">
        <div className="flex items-center gap-3">
          <div className="assistant-icon grid size-11 place-items-center rounded-2xl"><Sparkles size={20} /></div>
          <div>
            <h2 className="text-base font-semibold tracking-tight">Onyx Assistant</h2>
            <p className="text-xs text-muted-foreground">Your workspace, at your command</p>
          </div>
        </div>
        {messages.length > 0 && (
          <button onClick={() => setMessages([])} className="assistant-clear flex items-center gap-2 rounded-xl px-3 py-2 text-xs" aria-label="Clear conversation">
            <RotateCcw size={13} /> New chat
          </button>
        )}
      </div>

      {/* ── Transcript / empty state ── */}
      <div className="flex-1 space-y-5 overflow-y-auto scroll-slim py-7" aria-live="polite">
        {messages.length === 0 ? (
          <div className="assistant-welcome mx-auto flex max-w-2xl flex-col items-center pt-8 text-center sm:pt-16">
            <div className="assistant-orb mb-6 grid size-20 place-items-center rounded-[26px]"><Bot size={34} strokeWidth={1.6} /></div>
            <span className="assistant-eyebrow mb-3 inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[11px] font-medium uppercase tracking-[0.18em]">
              <span className="size-1.5 rounded-full bg-[#c9a227]" /> Your intelligent workspace
            </span>
            <h3 className="assistant-heading text-3xl font-semibold tracking-[-0.04em] sm:text-5xl">What can I help you <em className="not-italic">build?</em></h3>
            <p className="mt-4 max-w-md text-sm leading-7 text-muted-foreground">Explore your data, understand your activity, and manage records without leaving your flow.</p>
            <div className="mt-10 grid w-full grid-cols-1 gap-3 text-left sm:grid-cols-2">
              {PROMPTS.map(({ icon: Icon, title, subtitle, prompt }, i) => (
                <button key={title} onClick={() => send(prompt)} className="assistant-prompt group flex items-center gap-4 rounded-2xl p-4 text-left" style={{ animationDelay: `${i * 75}ms` }}>
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
          <div className="mx-auto max-w-3xl space-y-6 pb-6">
            {messages.map((message, i) => (
              <div key={i} className={`assistant-message flex gap-3 ${message.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {message.role === 'assistant' && <div className="assistant-icon grid size-8 shrink-0 place-items-center rounded-xl"><Sparkles size={15} /></div>}
                <div className={`max-w-[min(85%,680px)] ${message.role === 'user' ? 'assistant-user rounded-2xl rounded-tr-sm px-4 py-3 text-sm' : 'min-w-0 flex-1'}`}>
                  {message.role === 'assistant' ? (
                    <div className="space-y-3">
                      <p className={`text-sm leading-7 ${message.error ? 'text-[#e5484d]' : ''}`}>{message.text}</p>
                      {message.result !== undefined && (
                        <pre className="assistant-result max-h-80 overflow-auto rounded-xl p-4 text-left font-mono text-xs leading-6">{JSON.stringify(message.result, null, 2)}</pre>
                      )}
                      {message.action && (
                        <div className="assistant-confirm rounded-2xl p-4">
                          <div className="mb-3 flex items-center gap-2 text-xs font-semibold"><ShieldCheck size={16} /> Your approval is required</div>
                          <div className="mb-4 break-all font-mono text-xs opacity-75">
                            {message.action.tool} · {message.action.args.collection || 'default'}/{message.action.args.key}
                            {message.action.tool === 'set_record' && ` = ${JSON.stringify(message.action.args.value)}`}
                          </div>
                          <div className="flex gap-2">
                            <button className="assistant-approve inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold" disabled={busy} onClick={() => send('Confirm action', message.action!)}>
                              <Check size={14} /> Confirm
                            </button>
                            <button className="assistant-clear inline-flex items-center gap-2 rounded-xl px-4 py-2 text-xs" onClick={() => setMessages(previous => previous.map((m, index) => index === i ? { ...m, action: null } : m))}>
                              <X size={14} /> Cancel
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : message.text}
                </div>
              </div>
            ))}
            {busy && (
              <div className="assistant-message flex items-center gap-3 text-sm opacity-60">
                <div className="assistant-icon grid size-8 place-items-center rounded-xl"><Sparkles size={15} /></div>
                <Loader2 size={16} className="animate-spin" /> Thinking…
              </div>
            )}
            <div ref={end} />
          </div>
        )}
      </div>

      {/* ── Composer ── */}
      <div className="assistant-compose sticky bottom-0 mx-auto w-full max-w-3xl pb-5 pt-4">
        <form onSubmit={e => { e.preventDefault(); send(input) }} className="assistant-input flex items-end gap-2 rounded-2xl p-2 pl-4">
          <textarea
            ref={field}
            aria-label="Message Onyx Assistant"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }}
            placeholder="Ask anything about your workspace…"
            rows={1}
            maxLength={2000}
            className="max-h-36 min-h-10 flex-1 resize-none bg-transparent py-2 text-sm outline-none placeholder:opacity-45"
          />
          <button type="submit" disabled={busy || !input.trim()} className="assistant-send grid size-10 shrink-0 place-items-center rounded-xl disabled:opacity-40" aria-label="Send message">
            {busy ? <Loader2 size={16} className="animate-spin" /> : <ArrowUp size={18} />}
          </button>
        </form>
        <p className="mt-2 text-center text-[11px] text-muted-foreground">Actions require your approval · Telegram durability follows your workspace settings</p>
      </div>
    </div>
  )
}

'use client'

import { useState, useEffect, useMemo } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Save,
  Loader2,
  Trash2,
  ShieldCheck,
  ShieldAlert,
  CheckCircle2,
  AlertTriangle,
  Send,
  Lock,
  KeyRound,
  Code2,
  Copy,
  MessageSquare,
  Braces,
  Clock,
  FileText,
  Plus,
} from 'lucide-react'
import { useApi } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { toast } from 'sonner'

// ─────────────────────────────────────────────────────────────────────────────
// Types — mirror the API response shapes (all credential views are MASKED).
// ─────────────────────────────────────────────────────────────────────────────

interface CredentialView {
  name: string
  apiKeyMasked: string
  label: string | null
  fromName: string | null
  rateLimitPerMin: number | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

interface CredentialsResponse {
  credentials: CredentialView[]
  max: number
}

interface ConnectResponse {
  credential: CredentialView
  connection: {
    ok: boolean
    protocolVersion?: string
    serverName?: string
    serverVersion?: string
    inboxes?: { inbox_id: string; email: string; provider: string }[]
  }
  request_id?: string
}

interface TemplateView {
  name: string
  subject: string
  body: string
  htmlBody: string | null
  variables: string[]
  updatedAt: string
}

interface TelegramConfigResponse {
  customConfig: {
    chatId: string
    label: string | null
    hasCustomBotToken: boolean
    botApiBaseUrl: string | null
    updatedAt: string
  } | null
  effectiveChatIdMasked: string
  envBotConfigured: boolean
  hasCustomBotToken: boolean
}

interface SendResponse {
  ok: boolean
  success: boolean
  message: string
  request_id: string
  credential: string
  recipients: number
  variables_applied: string[]
  latency_ms: number
  upstream_message_id?: string
}

interface RecentRequest {
  request_id: string
  ts: string
  endpoint: string
  credential: string
  status: 'sent' | 'failed'
  latency_ms: number
  upstream_status?: number
  error_code?: string
}

/** Client-side $VAR_NAME$ detection — same pattern as the server engine. */
function detectVariables(...texts: (string | undefined)[]): string[] {
  const seen = new Set<string>()
  const re = /\$([A-Za-z_][A-Za-z0-9_]*)\$/g
  for (const text of texts) {
    if (!text) continue
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(text)) !== null) seen.add(m[1])
  }
  return [...seen]
}

// ─────────────────────────────────────────────────────────────────────────────
// Main view
// ─────────────────────────────────────────────────────────────────────────────

export function EmailAutomationView() {
  const api = useApi()
  const qc = useQueryClient()
  const { data: credData, refetch: refetchCreds } = useQuery({
    queryKey: ['email-credentials'],
    queryFn: () => api<CredentialsResponse>('/api/credentials'),
  })
  const credentials = credData?.credentials ?? []

  function refresh() {
    refetchCreds()
    qc.invalidateQueries({ queryKey: ['email-credentials'] })
    qc.invalidateQueries({ queryKey: ['email-requests'] })
    qc.invalidateQueries({ queryKey: ['email-templates'] })
  }

  return (
    <div>
      <PageHeader
        title="Email Automation"
        description="Privacy-first email automation API — your MCPEmail key, your Telegram channel, your rules. OTP, welcome mails, notifications, reports: one engine."
      />

      <div className="space-y-4 max-w-3xl">
        <PrivacyCard />
        <StatusBanner credentials={credentials} />
        <CredentialsCard credentials={credentials} onSaved={refresh} />
        <TelegramBridgeCard />
        <ComposerCard credentials={credentials} onSent={refresh} />
        <TemplatesCard onChanged={refresh} />
        <RecentSendsCard />
        <ApiReferenceCard />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Privacy disclaimer (PRD §2 — shown BEFORE connecting MCPEmail/Telegram)
// ─────────────────────────────────────────────────────────────────────────────

function PrivacyCard() {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) {
    return (
      <button
        onClick={() => setDismissed(false)}
        className="w-full text-left rounded-xl border border-amber-400/40 bg-amber-500/10 px-4 py-2.5 flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 hover:bg-amber-500/15 transition-colors"
      >
        <ShieldAlert className="size-3.5 shrink-0" />
        <span className="font-medium">Privacy disclaimer</span>
        <span className="text-amber-700/70 dark:text-amber-400/70">— tap to re-read before connecting credentials</span>
      </button>
    )
  }
  return (
    <Card className="p-5 border-amber-400/40 bg-amber-500/5">
      <div className="flex items-start gap-3">
        <ShieldAlert className="size-5 text-amber-500 mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-amber-700 dark:text-amber-400">Privacy Disclaimer</h3>
          <div className="mt-2 space-y-2 text-[12px] leading-relaxed text-muted-foreground">
            <p>
              For <strong className="text-foreground">private or sensitive email automation</strong>, use{' '}
              <strong className="text-foreground">your own Telegram credentials</strong> (bot + channel in{' '}
              <a href="#telegram" className="underline underline-offset-2 text-primary" onClick={(e) => { e.preventDefault(); document.getElementById('telegram-bridge')?.scrollIntoView({ behavior: 'smooth' }) }}>Settings → Telegram</a>) and{' '}
              <strong className="text-foreground">your own MCPEmail API key</strong>. Do not use credentials belonging to another person.
            </p>
            <ul className="space-y-1.5 list-none">
              <li className="flex gap-2">
                <CheckCircle2 className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                <span>Your <code className="font-mono text-[11px]">mcpe_*</code> key is a <strong className="text-foreground">user-owned credential</strong> — used only to execute requests on your behalf, never exposed, logged, or reused for other users.</span>
              </li>
              <li className="flex gap-2">
                <CheckCircle2 className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                <span>Telegram credentials/configuration belong to <strong className="text-foreground">you</strong> — your named credentials are mirrored to your private pinned manifest.</span>
              </li>
              <li className="flex gap-2">
                <AlertTriangle className="size-3.5 text-amber-500 shrink-0 mt-0.5" />
                <span>The <strong className="text-foreground">platform API key</strong> (<code className="font-mono text-[11px]">kv_live_*</code>) only authorizes access to this automation service. The <strong className="text-foreground">MCPEmail key</strong> is what authenticates with MCPEmail. <strong className="text-foreground">Never confuse the two.</strong></span>
              </li>
            </ul>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3 h-7 text-[11px] border-amber-400/40 text-amber-700 dark:text-amber-400 hover:bg-amber-500/10"
            onClick={() => setDismissed(true)}
          >
            Understood — dismiss
          </Button>
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Status banner
// ─────────────────────────────────────────────────────────────────────────────

function StatusBanner({ credentials }: { credentials: CredentialView[] }) {
  const connected = credentials.length > 0
  return (
    <Card
      className={`p-4 border ${
        connected ? 'bg-primary/5 border-primary/30' : 'bg-amber-500/5 border-amber-400/30'
      }`}
    >
      <div className="flex items-start gap-3">
        {connected ? (
          <CheckCircle2 className="size-4 text-primary mt-0.5 shrink-0" />
        ) : (
          <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
        )}
        <div className="text-sm min-w-0">
          <div className="font-medium">
            {connected
              ? `${connected ? credentials.length : 0} credential${credentials.length === 1 ? '' : 's'} connected`
              : 'No MCPEmail credentials connected'}
          </div>
          <p className="text-[12px] text-muted-foreground/80 mt-0.5">
            {connected ? (
              <>
                Sends reference a credential <strong className="text-foreground">by name</strong> — the raw key never leaves the server.{' '}
                <span className="font-mono text-primary">
                  {credentials.map((c) => c.name).slice(0, 4).join(', ')}
                  {credentials.length > 4 ? ` +${credentials.length - 4} more` : ''}
                </span>
              </>
            ) : (
              <>
                Connect a named credential below to enable{' '}
                <code className="font-mono">POST /api/email/send</code>. There is no project-wide fallback key — the API{' '}
                <strong className="text-foreground">fails closed</strong> without your credential.
              </>
            )}
          </p>
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Credentials card — named credential manager (add / update / delete)
// ─────────────────────────────────────────────────────────────────────────────

function CredentialsCard({
  credentials,
  onSaved,
}: {
  credentials: CredentialView[]
  onSaved: () => void
}) {
  const api = useApi()
  const [name, setName] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [fromName, setFromName] = useState('')
  const [rateLimit, setRateLimit] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    if (editing) {
      const cred = credentials.find((c) => c.name === editing)
      if (cred) {
        setName(cred.name)
        setLabel(cred.label ?? '')
        setFromName(cred.fromName ?? '')
        setRateLimit(cred.rateLimitPerMin != null ? String(cred.rateLimitPerMin) : '')
        setApiKey('')
      }
    }
  }, [editing, credentials])

  async function save() {
    const trimmedName = name.trim()
    const trimmedKey = apiKey.trim()
    if (!trimmedName) {
      toast.error('Enter a credential name (e.g. personal_email)')
      return
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(trimmedName)) {
      toast.error('Name: 1–64 chars, letters/digits/_/-, no leading dash')
      return
    }
    if (!trimmedKey && !editing) {
      toast.error('Paste your MCPEmail API key (mcpe_…) first')
      return
    }
    if (trimmedKey && (!trimmedKey.startsWith('mcpe_') || trimmedKey.length < 25)) {
      toast.error('Key must start with "mcpe_" and be at least 25 chars (e.g. mcpe_4c7b1e9a0d5f…)')
      return
    }
    setSaving(true)
    try {
      const res = await api<ConnectResponse>('/api/credentials/connect', {
        method: 'POST',
        body: JSON.stringify({
          name: trimmedName,
          ...(trimmedKey ? { apiKey: trimmedKey } : {}),
          label: label.trim() || undefined,
          fromName: fromName.trim() || undefined,
          rateLimitPerMin: rateLimit.trim() ? Number(rateLimit.trim()) : null,
          testConnection: true,
        }),
      })
      if (res.connection?.ok) {
        toast.success(
          `Connected as "${trimmedName}" — MCPEmails ${res.connection.serverName} v${res.connection.serverVersion}`,
        )
        if (res.connection.inboxes?.length) {
          toast.info(
            `${res.connection.inboxes.length} inbox(es): ${res.connection.inboxes
              .slice(0, 3)
              .map((i) => i.email)
              .join(', ')}${res.connection.inboxes.length > 3 ? '…' : ''}`,
          )
        }
      } else {
        toast.success(`Saved "${trimmedName}" (connection test skipped)`)
      }
      setApiKey('')
      setEditing(null)
      setName('')
      setLabel('')
      setFromName('')
      setRateLimit('')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove(credName: string) {
    if (!confirm(`Delete credential "${credName}"? Sends referencing it will fail closed (no fallback).`)) return
    setDeleting(credName)
    try {
      await api(`/api/credentials/${encodeURIComponent(credName)}`, { method: 'DELETE' })
      toast.success(`Credential "${credName}" deleted`)
      if (editing === credName) {
        setEditing(null)
        setName('')
        setApiKey('')
      }
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="size-4 text-primary" />
        <h3 className="text-sm font-medium">MCPEmail credentials</h3>
        <Badge variant="outline" className="font-mono text-[10px] ml-auto border-border/60 text-muted-foreground">
          {credentials.length} / 20
        </Badge>
      </div>

      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 mb-4 flex items-start gap-2">
        <ShieldCheck className="size-3.5 text-primary mt-0.5 shrink-0" />
        <p className="text-[11px] text-primary/80 leading-relaxed">
          Get your key from{' '}
          <a
            href="https://mcpemails.com/dashboard/api-keys"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2"
          >
            mcpemails.com → Dashboard → API Keys
          </a>
          . Select the <code className="font-mono">send:email</code> scope (plus <code className="font-mono">read:email</code> for the connection test). The key is stored only in YOUR account (mirrored to YOUR Telegram manifest) and returned masked — never to the browser again.
        </p>
      </div>

      {/* Existing credentials list */}
      {credentials.length > 0 && (
        <div className="space-y-2 mb-4">
          {credentials.map((cred) => (
            <div
              key={cred.name}
              className="rounded-md border border-border/40 bg-background/40 px-3 py-2.5 flex items-center gap-3 flex-wrap"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-xs font-medium text-primary">{cred.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{cred.apiKeyMasked}</span>
                  {cred.label && (
                    <Badge variant="outline" className="text-[10px] border-border/60 text-muted-foreground h-4 px-1.5">
                      {cred.label}
                    </Badge>
                  )}
                  {cred.rateLimitPerMin != null && (
                    <Badge variant="outline" className="text-[10px] border-primary/30 text-primary h-4 px-1.5">
                      {cred.rateLimitPerMin}/min cap
                    </Badge>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {cred.fromName ? `from: ${cred.fromName} · ` : ''}
                  {cred.lastUsedAt ? `last used ${new Date(cred.lastUsedAt).toLocaleString()}` : 'never used'}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-muted-foreground"
                  onClick={() => setEditing(editing === cred.name ? null : cred.name)}
                >
                  {editing === cred.name ? 'Cancel' : 'Update'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-[11px] text-muted-foreground hover:text-red-600"
                  onClick={() => remove(cred.name)}
                  disabled={deleting === cred.name}
                >
                  {deleting === cred.name ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / update form */}
      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cred-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Credential name <span className="text-muted-foreground/50 normal-case">(e.g. personal_email)</span>
            </Label>
            <Input
              id="cred-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="personal_email"
              className="font-mono text-sm h-9"
              disabled={Boolean(editing)}
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-label" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Label <span className="text-muted-foreground/50 normal-case">(optional)</span>
            </Label>
            <Input
              id="cred-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Personal inbox"
              className="text-sm h-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="cred-key" className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Lock className="size-3" /> MCPEmail API key
            {editing && <span className="text-muted-foreground/50 normal-case">(leave blank to keep the saved key)</span>}
          </Label>
          <div className="relative">
            <Input
              id="cred-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                editing
                  ? '•••••••• (kept — paste a new key to rotate)'
                  : 'mcpe_4c7b1e9a0d5f38a2b6e04d17c9f2a58b3d6e0f1a2b4c6d8e0f2a4b6c8d0e1f3a'
              }
              className="font-mono text-sm h-9 pr-16"
              autoComplete="off"
              spellCheck={false}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => setShowKey((v) => !v)}
            >
              {showKey ? 'Hide' : 'Show'}
            </Button>
          </div>
        </div>

        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="cred-from" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sender name <span className="text-muted-foreground/50 normal-case">(optional)</span>
            </Label>
            <Input
              id="cred-from"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="My App"
              className="text-sm h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cred-rate" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Custom rate limit <span className="text-muted-foreground/50 normal-case">(sends/min, blank = none)</span>
            </Label>
            <Input
              id="cred-rate"
              inputMode="numeric"
              value={rateLimit}
              onChange={(e) => setRateLimit(e.target.value.replace(/\D/g, '').slice(0, 5))}
              placeholder="30"
              className="text-sm h-9"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={save}
            disabled={saving || (!apiKey.trim() && !editing) || !name.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            {editing ? 'Update & test' : 'Save & test connection'}
          </Button>
          {editing && (
            <Button
              size="sm"
              variant="outline"
              className="border-border/60 text-muted-foreground"
              onClick={() => {
                setEditing(null)
                setName('')
                setApiKey('')
                setLabel('')
                setFromName('')
                setRateLimit('')
              }}
            >
              Cancel edit
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram bridge card — where the named credentials live (private channel)
// ─────────────────────────────────────────────────────────────────────────────

function TelegramBridgeCard() {
  const api = useApi()
  const { data } = useQuery({
    queryKey: ['telegram-config-bridge'],
    queryFn: () => api<TelegramConfigResponse>('/api/telegram/config'),
  })
  const custom = data?.customConfig ?? null
  const bridged = Boolean(custom || data?.effectiveChatIdMasked)

  return (
    <Card className="p-5 bg-card/40 border-border/60" id="telegram-bridge">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Telegram credential bridge</h3>
        <Badge
          variant="outline"
          className={`ml-auto text-[10px] h-5 ${
            bridged ? 'border-primary/30 text-primary' : 'border-border/60 text-muted-foreground'
          }`}
        >
          {bridged ? 'private channel connected' : 'env default'}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
        Your named credentials are stored inside <strong className="text-foreground">your own account</strong> and mirrored to your
        private pinned Telegram manifest — that channel is the durable credential store (it survives cold boots). For private
        work, use <strong className="text-foreground">your own</strong> bot + channel so the configuration is not shared with anyone.
      </p>
      <div className="rounded-md border border-border/40 bg-background/40 p-3 text-[11px] space-y-1.5">
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Effective chat</span>
          <span className="font-mono text-primary">{data?.effectiveChatIdMasked || 'not configured'}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Bot</span>
          <span className="font-mono">
            {data?.hasCustomBotToken ? 'your own bot token' : data?.envBotConfigured ? 'server default bot' : 'not configured'}
          </span>
        </div>
        {custom?.label && (
          <div className="flex justify-between gap-3">
            <span className="text-muted-foreground">Channel label</span>
            <span>{custom.label}</span>
          </div>
        )}
        <div className="flex justify-between gap-3">
          <span className="text-muted-foreground">Bot API</span>
          <span className="font-mono">{custom?.botApiBaseUrl || 'cloud (api.telegram.org)'}</span>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground/80 mt-3">
        Manage the channel in <strong className="text-foreground">Settings → Telegram</strong>, via{' '}
        <code className="font-mono">POST /api/telegram/connect</code>, or <code className="font-mono">GET /api/telegram/config</code>.
      </p>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Composer — send a real email with live $VAR_NAME$ detection
// ─────────────────────────────────────────────────────────────────────────────

function ComposerCard({
  credentials,
  onSent,
}: {
  credentials: CredentialView[]
  onSent: () => void
}) {
  const api = useApi()
  const [credential, setCredential] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('Hello $NAME$')
  const [body, setBody] = useState('Hello $NAME$,\n\nWelcome to Onyx Base.\n\nYour code: $OTP$')
  const [varValues, setVarValues] = useState<Record<string, string>>({})
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<SendResponse | null>(null)

  useEffect(() => {
    if (credentials.length > 0 && !credential) setCredential(credentials[0].name)
  }, [credentials, credential])

  const detected = useMemo(() => detectVariables(subject, body), [subject, body])

  async function send() {
    if (!credential) {
      toast.error('Connect a credential first')
      return
    }
    const trimmedTo = to.trim()
    if (!trimmedTo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedTo)) {
      toast.error('Enter a valid recipient email')
      return
    }
    setSending(true)
    setResult(null)
    try {
      const res = await api<SendResponse>('/api/email/send', {
        method: 'POST',
        body: JSON.stringify({
          credential,
          to: trimmedTo,
          subject,
          body,
          variables: varValues,
        }),
      })
      setResult(res)
      toast.success(`Sent — request ${res.request_id}`)
      onSent()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <Send className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Composer</h3>
        <span className="ml-auto text-[10px] text-muted-foreground">POST /api/email/send</span>
      </div>

      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Credential</Label>
            <select
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className="h-9 w-full rounded-md border border-border/60 bg-background/60 px-3 text-sm text-foreground outline-none focus:border-primary/50"
            >
              {credentials.length === 0 && <option value="">(none connected)</option>}
              {credentials.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="compose-to" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              To
            </Label>
            <Input
              id="compose-to"
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="recipient@example.com"
              className="text-sm h-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="compose-subject" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Subject <span className="text-muted-foreground/50 normal-case">($VAR_NAME$ supported)</span>
          </Label>
          <Input
            id="compose-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="text-sm h-9"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="compose-body" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Message <span className="text-muted-foreground/50 normal-case">(plain text, $VAR_NAME$ supported)</span>
          </Label>
          <Textarea
            id="compose-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            className="text-sm min-h-[110px] font-mono"
          />
        </div>

        {detected.length > 0 && (
          <div className="rounded-md border border-primary/20 bg-primary/5 p-3">
            <div className="text-[11px] font-medium text-primary/90 mb-2 flex items-center gap-1.5">
              <Braces className="size-3" /> Variables detected ({detected.length})
            </div>
            <div className="grid sm:grid-cols-2 gap-2">
              {detected.map((v) => (
                <div key={v} className="flex items-center gap-2">
                  <span className="font-mono text-[11px] text-primary w-24 shrink-0 truncate">${v}$</span>
                  <Input
                    value={varValues[v] ?? ''}
                    onChange={(e) => setVarValues((prev) => ({ ...prev, [v]: e.target.value }))}
                    placeholder={`value for ${v}`}
                    className="h-8 text-xs"
                  />
                </div>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/70 mt-2">
              Missing variables are detected server-side too — the send fails closed with{' '}
              <code className="font-mono">missing_variable</code> instead of mailing half-rendered content.
            </p>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={send}
            disabled={sending || !credential || !to.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            Send email
          </Button>
          {result && (
            <span className="text-[11px] text-muted-foreground font-mono truncate">
              {result.request_id} · {result.latency_ms}ms
              {result.upstream_message_id ? ` · msg ${result.upstream_message_id.slice(0, 12)}` : ''}
            </span>
          )}
        </div>

        {result && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-[11px] space-y-1">
            <div className="flex items-center gap-1.5 text-primary font-medium">
              <CheckCircle2 className="size-3.5" /> {result.message}
            </div>
            <div className="font-mono text-muted-foreground">
              request_id: {result.request_id} · status:{' '}
              <a
                href={`/api/email/status/${result.request_id}`}
                target="_blank"
                rel="noopener"
                className="underline underline-offset-2 text-primary"
              >
                GET /api/email/status/{result.request_id}
              </a>
            </div>
            {result.variables_applied.length > 0 && (
              <div className="text-muted-foreground">
                variables applied: {result.variables_applied.map((v) => `$${v}$`).join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Templates card — one structure, different variables per request
// ─────────────────────────────────────────────────────────────────────────────

function TemplatesCard({ onChanged }: { onChanged: () => void }) {
  const api = useApi()
  const { data } = useQuery({
    queryKey: ['email-templates'],
    queryFn: () => api<{ templates: TemplateView[] }>('/api/email/templates'),
  })
  const templates = data?.templates ?? []

  const [name, setName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function save() {
    if (!name.trim() || !subject.trim() || !body.trim()) {
      toast.error('Template name, subject and body are all required')
      return
    }
    setSaving(true)
    try {
      await api('/api/email/templates', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), subject, body }),
      })
      toast.success(`Template "${name.trim()}" saved`)
      setName('')
      setSubject('')
      setBody('')
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function remove(tplName: string) {
    if (!confirm(`Delete template "${tplName}"?`)) return
    setDeleting(tplName)
    try {
      await api(`/api/email/templates/${encodeURIComponent(tplName)}`, { method: 'DELETE' })
      toast.success(`Template "${tplName}" deleted`)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeleting(null)
    }
  }

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <FileText className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Templates</h3>
        <Badge variant="outline" className="font-mono text-[10px] ml-auto border-border/60 text-muted-foreground">
          {templates.length} / 50
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Keep one email structure, vary the variables per request —{' '}
        <code className="font-mono text-[11px]">POST /api/email/template/send {'{ "template": "welcome", "variables": {…} }'}</code>.
        Templates are stored in your account; nothing is rebuilt on send.
      </p>

      {templates.length > 0 && (
        <div className="space-y-2 mb-4">
          {templates.map((tpl) => (
            <div key={tpl.name} className="rounded-md border border-border/40 bg-background/40 px-3 py-2.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs font-medium text-primary">{tpl.name}</span>
                {tpl.variables.map((v) => (
                  <Badge key={v} variant="outline" className="text-[10px] h-4 px-1.5 font-mono border-primary/30 text-primary">
                    ${v}$
                  </Badge>
                ))}
                <div className="ml-auto flex items-center gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-muted-foreground"
                    onClick={() => {
                      setName(tpl.name)
                      setSubject(tpl.subject)
                      setBody(tpl.body)
                    }}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-[11px] text-muted-foreground hover:text-red-600"
                    onClick={() => remove(tpl.name)}
                    disabled={deleting === tpl.name}
                  >
                    {deleting === tpl.name ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
                  </Button>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground/80 mt-1 truncate">{tpl.subject}</div>
            </div>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="grid sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tpl-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Template name
            </Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="welcome"
              className="font-mono text-sm h-9"
              spellCheck={false}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="tpl-subject" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Subject
            </Label>
            <Input
              id="tpl-subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Welcome, $NAME$"
              className="text-sm h-9"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tpl-body" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Body <span className="text-muted-foreground/50 normal-case">(plain text)</span>
          </Label>
          <Textarea
            id="tpl-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'Hello $NAME$,\n\nWelcome to $PRODUCT$. Your code is $OTP$.'}
            className="text-sm min-h-[80px] font-mono"
          />
        </div>
        <Button size="sm" onClick={save} disabled={saving} className="bg-primary hover:bg-primary/90 text-primary-foreground">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
          Save template
        </Button>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Recent sends — metadata-only activity (request IDs, latency, status)
// ─────────────────────────────────────────────────────────────────────────────

function RecentSendsCard() {
  const api = useApi()
  const { data } = useQuery({
    queryKey: ['email-requests'],
    queryFn: () => api<{ requests: RecentRequest[] }>('/api/email/requests'),
  })
  const requests = data?.requests ?? []
  if (requests.length === 0) return null

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <Clock className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Recent sends</h3>
        <span className="ml-auto text-[10px] text-muted-foreground">metadata only — never email content</span>
      </div>
      <div className="space-y-2 max-h-72 overflow-y-auto scroll-slim">
        {requests.slice(0, 20).map((r) => (
          <div
            key={r.request_id}
            className="rounded-md border border-border/40 bg-background/40 px-3 py-2 flex items-center gap-3 flex-wrap text-[11px]"
          >
            <span
              className={`inline-flex items-center gap-1 font-medium ${
                r.status === 'sent' ? 'text-primary' : 'text-red-600'
              }`}
            >
              {r.status === 'sent' ? <CheckCircle2 className="size-3" /> : <AlertTriangle className="size-3" />}
              {r.status}
            </span>
            <span className="font-mono text-muted-foreground truncate">{r.request_id}</span>
            <span className="font-mono text-muted-foreground/70">{r.credential}</span>
            <span className="ml-auto text-muted-foreground/70">{new Date(r.ts).toLocaleString()}</span>
            <span className="text-muted-foreground/70">{r.latency_ms}ms</span>
            {r.error_code && <Badge variant="outline" className="text-[10px] h-4 px-1.5 border-red-400/30 text-red-600">{r.error_code}</Badge>}
          </div>
        ))}
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// API reference card — curl examples (masked platform key)
// ─────────────────────────────────────────────────────────────────────────────

function ApiReferenceCard() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const maskedKey = apiKey && apiKey.length > 16 ? `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}` : apiKey ?? 'kv_live_…'
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://onyxbase-phi.vercel.app'
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(text: string, which: string) {
    await navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  const connectCurl = `# 1. Connect YOUR MCPEmail key as a named credential (one-time)
curl -X POST ${origin}/api/credentials/connect \\
  -H "Authorization: Bearer ${maskedKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"personal_email","apiKey":"mcpe_YOUR_KEY"}'`

  const sendCurl = `# 2. Send any automated email — reference the credential BY NAME
curl -X POST ${origin}/api/email/send \\
  -H "Authorization: Bearer ${maskedKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"credential":"personal_email",
       "to":"user@example.com",
       "subject":"Welcome $NAME$",
       "body":"Hello $NAME$, your code is $OTP$.",
       "variables":{"NAME":"Akshay","OTP":"483921"}}'`

  const templateCurl = `# 3. Or use a stored template (structure saved once)
curl -X POST ${origin}/api/email/template/send \\
  -H "Authorization: Bearer ${maskedKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"credential":"personal_email","template":"welcome",
       "to":"user@example.com","variables":{"NAME":"Akshay","OTP":"483921"}}'`

  const statusCurl = `# 4. Check a request by ID (metadata only)
curl ${origin}/api/email/status/req_xxxxxxxx \\
  -H "Authorization: Bearer ${maskedKey}"`

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <Code2 className="size-4 text-primary" />
        <h3 className="text-sm font-medium">API reference</h3>
        <a href="/docs#email" target="_blank" rel="noopener" className="ml-auto text-[11px] text-primary underline underline-offset-2">
          Full docs (public) →
        </a>
      </div>

      <div className="space-y-3">
        <CodeBlock title="POST /api/credentials/connect" description="One-time setup: store YOUR mcpe_* key under a name. Response returns the masked key only." code={connectCurl} copied={copied === 'connect'} onCopy={() => copy(connectCurl, 'connect')} />
        <CodeBlock title="POST /api/email/send" description="Generic send with $VAR_NAME$ variables. Auth = platform key; MCPEmail hop uses your named credential." code={sendCurl} copied={copied === 'send'} onCopy={() => copy(sendCurl, 'send')} />
        <CodeBlock title="POST /api/email/template/send" description="Send with a stored template by name — variables per request, template never rebuilt." code={templateCurl} copied={copied === 'template'} onCopy={() => copy(templateCurl, 'template')} />
        <CodeBlock title="GET /api/email/status/:requestId" description="Status tracking by request ID — never exposes credentials or content." code={statusCurl} copied={copied === 'status'} onCopy={() => copy(statusCurl, 'status')} />

        <div className="rounded-md border border-border/40 bg-background/40 p-3 text-[11px] text-muted-foreground/80 leading-relaxed">
          <div className="font-medium text-foreground/90 mb-1">Key rules</div>
          <ul className="space-y-1 list-disc pl-4">
            <li><code className="font-mono">Authorization: Bearer kv_live_…</code> is the <strong className="text-foreground">platform key</strong> — it authenticates you to this API and is never forwarded to MCPEmail.</li>
            <li>The <strong className="text-foreground">MCPEmail key</strong> is resolved by <code className="font-mono">credential</code> name from your private store and used only for the MCPEmail hop.</li>
            <li>Unknown <code className="font-mono">$VARIABLE$</code> → 400 <code className="font-mono">missing_variable</code> (send aborted, never half-rendered).</li>
            <li>Missing credential → 404 <code className="font-mono">credential_not_found</code>. There is NO project-wide fallback — the system fails closed.</li>
            <li>Old <code className="font-mono">/api/email-otp/*</code> endpoints return 410 with a migration guide.</li>
          </ul>
        </div>
      </div>
    </Card>
  )
}

function CodeBlock({
  title,
  description,
  code,
  copied,
  onCopy,
}: {
  title: string
  description: string
  code: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="rounded-md border border-border/40 bg-background/40 overflow-hidden">
      <div className="px-3 py-2 border-b border-border/40 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-mono text-xs text-primary truncate">{title}</div>
          <div className="text-[11px] text-muted-foreground/80 mt-0.5">{description}</div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopy}
          className="h-7 px-2 text-[11px] text-muted-foreground shrink-0"
        >
          {copied ? <CheckCircle2 className="size-3" /> : <Copy className="size-3" />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
      <pre className="font-mono text-[11px] leading-relaxed text-primary/90 px-3 py-2.5 overflow-x-auto whitespace-pre">
        {code}
      </pre>
    </div>
  )
}

'use client'

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Save,
  Loader2,
  Trash2,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  Send,
  Lock,
  Inbox,
  KeyRound,
  Code2,
  Copy,
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

interface McpeConfigView {
  hasConfig: boolean
  apiKeyMasked: string
  label: string | null
  fromName: string | null
  subjectTemplate: string | null
  bodyTemplate: string | null
  updatedAt: string | null
}

interface McpeConfigResponse {
  config: McpeConfigView
  defaults: { subject: string; body: string }
}

interface McpeSaveResponse {
  config: McpeConfigView
  connection: {
    ok: boolean
    protocolVersion?: string
    serverName?: string
    serverVersion?: string
    inboxes?: { inbox_id: string; email: string; provider: string }[]
    error?: string
  }
  savedAt: string
}

export function EmailOtpView() {
  const api = useApi()
  const qc = useQueryClient()
  const apiKey = useOnyxBase((s) => s.apiKey)

  const { data, refetch } = useQuery({
    queryKey: ['mcpemail-config'],
    queryFn: () => api<McpeConfigResponse>('/api/dashboard/mcpemail-config'),
  })
  const config = data?.config
  const defaults = data?.defaults

  return (
    <div>
      <PageHeader
        title="Email OTP"
        description="Send one-time passwords via MCPEmails. Unlimited free OTP API calls — you only pay MCPEmails for the email sends."
      />

      <div className="space-y-4 max-w-3xl">
        {/* Status banner */}
        <Card
          className={`p-4 border ${
            config?.hasConfig
              ? 'bg-primary/5 border-primary/30'
              : 'bg-amber-500/5 border-amber-400/30'
          }`}
        >
          <div className="flex items-start gap-3">
            {config?.hasConfig ? (
              <CheckCircle2 className="size-4 text-primary mt-0.5 shrink-0" />
            ) : (
              <AlertTriangle className="size-4 text-amber-500 mt-0.5 shrink-0" />
            )}
            <div className="text-sm">
              <div className="font-medium">
                {config?.hasConfig ? 'MCPEmails connected' : 'MCPEmails not configured'}
              </div>
              <p className="text-[12px] text-muted-foreground/80 mt-0.5">
                {config?.hasConfig ? (
                  <>
                    Key <code className="font-mono text-primary">{config.apiKeyMasked}</code>
                    {config.updatedAt && (
                      <> · saved {new Date(config.updatedAt).toLocaleString()}</>
                    )}
                  </>
                ) : (
                  <>Paste your <code className="font-mono">mcpe_*</code> API key below to enable the OTP API.</>
                )}
              </p>
            </div>
          </div>
        </Card>

        {/* Config card */}
        <ConfigCard
          config={config ?? null}
          defaults={defaults ?? null}
          onSaved={() => {
            refetch()
            qc.invalidateQueries({ queryKey: ['mcpemail-config'] })
          }}
        />

        {/* Try-it card */}
        <TryItCard apiKey={apiKey ?? ''} />

        {/* Documentation */}
        <DocumentationCard apiKey={apiKey ?? ''} />
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Config card — paste the MCPEmail API key, optional templates.
// ─────────────────────────────────────────────────────────────────────────────

function ConfigCard({
  config,
  defaults,
  onSaved,
}: {
  config: McpeConfigView | null
  defaults: { subject: string; body: string } | null
  onSaved: () => void
}) {
  const api = useApi()
  const [apiKey, setApiKey] = useState('')
  const [label, setLabel] = useState('')
  const [fromName, setFromName] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    if (config) {
      setLabel(config.label ?? '')
      setFromName(config.fromName ?? '')
      setSubject(config.subjectTemplate ?? defaults?.subject ?? '')
      setBody(config.bodyTemplate ?? defaults?.body ?? '')
    } else if (defaults) {
      setSubject(defaults.subject)
      setBody(defaults.body)
    }
  }, [config, defaults])

  async function save() {
    const trimmed = apiKey.trim()
    if (!trimmed) {
      toast.error('Paste your MCPEmail API key first')
      return
    }
    if (!trimmed.startsWith('mcpe_') || trimmed.length < 25) {
      toast.error('Key must start with "mcpe_" and be at least 25 chars (e.g. mcpe_4c7b1e9a0d5f…)')
      return
    }
    setSaving(true)
    try {
      const res = await api<McpeSaveResponse>('/api/dashboard/mcpemail-config', {
        method: 'PUT',
        body: JSON.stringify({
          apiKey: trimmed,
          label: label.trim() || undefined,
          fromName: fromName.trim() || undefined,
          subjectTemplate: subject.trim() || undefined,
          bodyTemplate: body.trim() || undefined,
          testConnection: true,
        }),
      })
      if (res.connection?.ok) {
        toast.success(
          `MCPEmails connected — server ${res.connection.serverName} v${res.connection.serverVersion}`,
        )
        if (res.connection.inboxes && res.connection.inboxes.length > 0) {
          toast.info(
            `Found ${res.connection.inboxes.length} inbox(es): ${res.connection.inboxes
              .slice(0, 3)
              .map((i) => i.email)
              .join(', ')}${res.connection.inboxes.length > 3 ? '…' : ''}`,
          )
        }
      } else {
        toast.success('MCPEmail API key saved (connection test skipped)')
      }
      setApiKey('') // Clear the input after save
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function clearConfig() {
    if (!confirm('Remove your MCPEmail API key? The OTP API will stop working until you re-add it.')) return
    setClearing(true)
    try {
      await api('/api/dashboard/mcpemail-config', { method: 'DELETE' })
      toast.success('MCPEmail config cleared')
      setApiKey('')
      setLabel('')
      setFromName('')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clear failed')
    } finally {
      setClearing(false)
    }
  }

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <KeyRound className="size-4 text-primary" />
        <h3 className="text-sm font-medium">MCPEmail API key</h3>
        {config?.hasConfig ? (
          <Badge variant="outline" className="font-mono text-[10px] ml-auto border-primary/30 text-primary">
            {config.apiKeyMasked}
          </Badge>
        ) : (
          <Badge variant="outline" className="font-mono text-[10px] ml-auto border-border/60 text-muted-foreground">
            not set
          </Badge>
        )}
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
          . Select the <code className="font-mono">send:email</code> scope (and <code className="font-mono">read:email</code> for connection test). Your key is stored server-side and never returned to the browser after saving.
        </p>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="mcpe-key" className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Lock className="size-3" /> MCPEmail API key <span className="text-muted-foreground/50 normal-case">(mcpe_…)</span>
          </Label>
          <div className="relative">
            <Input
              id="mcpe-key"
              type={showKey ? 'text' : 'password'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={config?.hasConfig ? '•••••••• (saved — paste a new key to replace)' : 'mcpe_4c7b1e9a0d5f38a2b6e04d17c9f2a58b3d6e0f1a2b4c6d8e0f2a4b6c8d0e1f3a'}
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
            <Label htmlFor="mcpe-label" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Label <span className="text-muted-foreground/50 normal-case">(optional)</span>
            </Label>
            <Input
              id="mcpe-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Production key"
              className="text-sm h-9"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="mcpe-from" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sender name <span className="text-muted-foreground/50 normal-case">(optional)</span>
            </Label>
            <Input
              id="mcpe-from"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
              placeholder="My App OTP"
              className="text-sm h-9"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mcpe-subject" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Subject template <span className="text-muted-foreground/50 normal-case">($CODE → the 6-digit code)</span>
          </Label>
          <Input
            id="mcpe-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Your verification code"
            className="text-sm h-9"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="mcpe-body" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Body template <span className="text-muted-foreground/50 normal-case">($CODE → the 6-digit code)</span>
          </Label>
          <Textarea
            id="mcpe-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Your verification code is $CODE. It expires in 10 minutes."
            className="text-sm min-h-[80px] font-mono"
          />
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={save}
            disabled={saving || !apiKey.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save & test connection
          </Button>
          {config?.hasConfig && (
            <Button
              size="sm"
              variant="outline"
              onClick={clearConfig}
              disabled={clearing}
              className="border-border/60 text-muted-foreground hover:text-red-600 hover:border-red-400/30"
            >
              {clearing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Remove key
            </Button>
          )}
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Try-it card — actually send + verify an OTP from the dashboard.
// ─────────────────────────────────────────────────────────────────────────────

function TryItCard({ apiKey }: { apiKey: string }) {
  const api = useApi()
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [code, setCode] = useState('')
  const [devCode, setDevCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<string | null>(null)

  async function sendOtp() {
    const trimmed = email.trim()
    if (!trimmed) {
      toast.error('Enter an email address')
      return
    }
    setSending(true)
    setDevCode(null)
    setExpiresAt(null)
    try {
      const res = await api<{ expiresAt: string; ttl: number; _devCode?: string }>(
        '/api/email-otp/send',
        {
          method: 'POST',
          body: JSON.stringify({ email: trimmed }),
        },
      )
      setExpiresAt(res.expiresAt)
      if (res._devCode) {
        setDevCode(res._devCode)
        toast.success(`OTP sent — dev code: ${res._devCode} (visible because NODE_ENV !== production)`)
      } else {
        toast.success('OTP sent — check your inbox')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Send failed')
    } finally {
      setSending(false)
    }
  }

  async function verifyOtp() {
    const trimmed = code.trim()
    if (!/^\d{6}$/.test(trimmed)) {
      toast.error('Enter the 6-digit code')
      return
    }
    setVerifying(true)
    try {
      await api('/api/email-otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim(), code: trimmed }),
      })
      toast.success('Code verified ✓')
      setCode('')
      setDevCode(null)
      setExpiresAt(null)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Verify failed')
    } finally {
      setVerifying(false)
    }
  }

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <Send className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Try it</h3>
        {expiresAt && (
          <Badge variant="outline" className="font-mono text-[10px] ml-auto border-primary/30 text-primary">
            expires {new Date(expiresAt).toLocaleTimeString()}
          </Badge>
        )}
      </div>

      <p className="text-xs text-muted-foreground mb-3">
        Send a real OTP to an email address you control, then verify the code below. This uses the same API your application code will call.
      </p>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="try-email" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recipient email
          </Label>
          <div className="flex gap-2">
            <Input
              id="try-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="user@example.com"
              className="text-sm h-9"
            />
            <Button
              size="sm"
              onClick={sendOtp}
              disabled={sending || !email.trim()}
              className="bg-primary hover:bg-primary/90 text-primary-foreground h-9"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-3.5" />}
              Send OTP
            </Button>
          </div>
        </div>

        {devCode && (
          <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 text-[11px] flex items-center gap-2">
            <Inbox className="size-3.5 text-primary shrink-0" />
            <span>
              <span className="text-muted-foreground">Dev code (NODE_ENV ≠ production):</span>{' '}
              <code className="font-mono text-primary font-medium">{devCode}</code>
            </span>
          </div>
        )}

        <div className="space-y-1.5">
          <Label htmlFor="try-code" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Verification code
          </Label>
          <div className="flex gap-2">
            <Input
              id="try-code"
              inputMode="numeric"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="123456"
              className="font-mono text-sm h-9 tracking-[0.5em]"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={verifyOtp}
              disabled={verifying || !/^\d{6}$/.test(code)}
              className="border-primary/30 text-primary hover:bg-primary/10 h-9"
            >
              {verifying ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
              Verify
            </Button>
          </div>
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Documentation card — curl examples.
// ─────────────────────────────────────────────────────────────────────────────

function DocumentationCard({ apiKey }: { apiKey: string }) {
  const maskedKey = apiKey.length > 16 ? `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}` : apiKey
  const origin = typeof window !== 'undefined' ? window.location.origin : 'https://onyxbase-phi.vercel.app'
  const [copied, setCopied] = useState<string | null>(null)

  async function copy(text: string, which: string) {
    await navigator.clipboard.writeText(text)
    setCopied(which)
    setTimeout(() => setCopied(null), 1500)
  }

  const sendCurl = `# Send an OTP
curl -X POST ${origin}/api/email-otp/send \\
  -H "Authorization: Bearer ${maskedKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com"}'`

  const verifyCurl = `# Verify the code
curl -X POST ${origin}/api/email-otp/verify \\
  -H "Authorization: Bearer ${maskedKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"email":"user@example.com","code":"123456"}'`

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <Code2 className="size-4 text-primary" />
        <h3 className="text-sm font-medium">API reference</h3>
      </div>

      <div className="space-y-3">
        <CodeBlock
          title="POST /api/email-otp/send"
          description="Issues a 6-digit OTP, sends it via MCPEmails, stores the hashed record (10-min TTL). 5 OTPs per IP per 10 minutes."
          code={sendCurl}
          copied={copied === 'send'}
          onCopy={() => copy(sendCurl, 'send')}
        />
        <CodeBlock
          title="POST /api/email-otp/verify"
          description="Verifies the code. On success the OTP is single-use deleted. On 5 wrong attempts the OTP is voided."
          code={verifyCurl}
          copied={copied === 'verify'}
          onCopy={() => copy(verifyCurl, 'verify')}
        />

        <div className="rounded-md border border-border/40 bg-background/40 p-3 text-[11px] text-muted-foreground/80 leading-relaxed">
          <div className="font-medium text-foreground/90 mb-1">Notes</div>
          <ul className="space-y-1 list-disc pl-4">
            <li>OTP codes are 6-digit, cryptographically random, hashed with SHA-256 + per-record salt before storage.</li>
            <li>TTL is 10 minutes. After 5 wrong verification attempts the code is voided.</li>
            <li>The <code className="font-mono">Authorization</code> header carries your Onyx Base API key (<code className="font-mono">kv_live_*</code>), not the MCPEmail key. The MCPEmail key is configured here and read server-side.</li>
            <li>Per-call overrides: pass <code className="font-mono">{`{ "subject": "...", "body": "...", "fromName": "..." }`}</code> to the send endpoint to customize the email per-request. Use <code className="font-mono">$CODE</code> as a placeholder for the 6-digit code.</li>
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
      <div className="px-3 py-2 border-b border-border/40 flex items-center justify-between">
        <div>
          <div className="font-mono text-xs text-primary">{title}</div>
          <div className="text-[11px] text-muted-foreground/80 mt-0.5">{description}</div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCopy}
          className="h-7 px-2 text-[11px] text-muted-foreground"
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

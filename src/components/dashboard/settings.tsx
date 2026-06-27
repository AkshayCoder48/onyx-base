'use client'

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Settings as SettingsIcon,
  Copy,
  Terminal,
  CheckCircle2,
  LogOut,
  User,
  AlertTriangle,
  MessageCircle,
  Save,
  Loader2,
  ShieldCheck,
  Trash2,
  Lock,
  Server,
  HardDrive,
} from 'lucide-react'
import { useApi, type StatsView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { maskKey, formatBytes } from './shared'
import { toast } from 'sonner'

interface TelegramStatus {
  ok: boolean
  chatType?: string | null
  error?: string | null
}

interface StatusResponse {
  telegram: TelegramStatus
  customConfig: { chatId: string; label: string | null; hasCustomBotToken: boolean; botApiBaseUrl: string | null; updatedAt: string } | null
  envChatIdMasked: string
  envChatIdConfigured: boolean
  envBotConfigured: boolean
  botApiBackend: string
  usingLocalBotApi: boolean
  maxFileUploadBytes: number
  envBotApiUrl: string
}

export function SettingsView() {
  const api = useApi()
  const qc = useQueryClient()
  const user = useOnyxBase((s) => s.user)
  const apiKey = useOnyxBase((s) => s.apiKey)
  const clearSession = useOnyxBase((s) => s.clearSession)

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<StatsView>('/api/dashboard/stats'),
  })
  const { data: statusData, refetch: refetchStatus } = useQuery({
    queryKey: ['telegram-status'],
    queryFn: () => api<StatusResponse>('/api/dashboard/status'),
    refetchInterval: 30000,
  })
  const telegram = statusData?.telegram
  const customConfig = statusData?.customConfig
  const envChatIdMasked = statusData?.envChatIdMasked

  async function copyKey() {
    if (!apiKey) return
    await navigator.clipboard.writeText(apiKey)
    toast.success('API key copied')
  }

  function logout() {
    clearSession()
    toast.success('Signed out')
  }

  return (
    <div>
      <PageHeader title="Settings" description="Account details, storage backend, Telegram config, and CLI setup." />

      <div className="space-y-4 max-w-3xl">
        {/* Account */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="flex items-center gap-2 mb-4">
            <User className="size-4 text-primary" />
            <h3 className="text-sm font-medium">Account</h3>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <Field label="User ID" value={<code className="font-mono">{user?.userId}</code>} />
            <Field label="Name" value={user?.name || '—'} />
            <Field label="Plan" value={<Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">Unlimited &amp; free</Badge>} />
            <Field label="Member since" value={<span className="font-mono text-xs">{user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}</span>} />
          </div>
        </Card>

        {/* Current API key */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="flex items-center gap-2 mb-4">
            <SettingsIcon className="size-4 text-primary" />
            <h3 className="text-sm font-medium">Current session key</h3>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 font-mono text-sm text-primary/90 bg-background/60 rounded-md px-3 py-2 border border-border/40 break-all">
              {maskKey(apiKey ?? '')}
            </code>
            <Button variant="outline" size="sm" onClick={copyKey}>
              <Copy className="size-3.5" /> Copy
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-2">
            This is the key used to authenticate this dashboard session. Manage all keys in the API Keys tab.
          </p>
        </Card>

        {/* Storage backend + Telegram status */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle2 className="size-4 text-primary" />
            <h3 className="text-sm font-medium">Storage backend</h3>
          </div>
          <div className="grid sm:grid-cols-2 gap-4 text-sm">
            <Field label="Engine" value={<code className="font-mono text-xs">Telegram</code>} />
            <Field label="Records" value={<span className="font-mono">{stats?.records ?? '—'}</span>} />
            <Field label="Collections" value={<span className="font-mono">{stats?.collections ?? '—'}</span>} />
            <Field label="Indexed size" value={<span className="font-mono">{stats ? formatBytes(stats.storageBytes) : '—'}</span>} />
          </div>
          <div className="mt-4 rounded-md border border-border/40 bg-background/40 p-3">
            <div className="flex items-center gap-2 mb-1.5">
              {telegram?.ok ? (
                <CheckCircle2 className="size-3.5 text-primary" />
              ) : (
                <AlertTriangle className="size-3.5 text-amber-400" />
              )}
              <span className="text-xs font-medium">
                Telegram {telegram?.ok ? 'connected' : 'not reachable'}
              </span>
              {telegram?.ok && telegram.chatType && (
                <Badge variant="outline" className="font-mono text-[10px] ml-auto border-primary/30 text-primary">
                  {telegram.chatType}
                </Badge>
              )}
            </div>
            {telegram?.ok ? (
              <p className="text-[11px] text-muted-foreground/80">
                Backup chat reachable ({telegram.chatType ?? 'chat'}). Every write mirrors a structured backup message.
              </p>
            ) : (
              <div className="text-[11px] text-muted-foreground/80 space-y-1.5">
                <p>
                  Bot can&apos;t reach the backup chat
                  {telegram?.error ? `: ${telegram.error}` : '.'}
                </p>
                <p className="text-stone-600">
                  Make sure the bot has been added to your channel/group as an admin, or set your own chat ID in the &quot;Telegram chat ID&quot; section below.
                </p>
              </div>
            )}
          </div>
        </Card>

        {/* Telegram chat ID + bot token config — the new feature */}
        <TelegramChatIdCard
          customConfig={customConfig ?? null}
          envChatIdMasked={envChatIdMasked ?? ''}
          envChatIdConfigured={statusData?.envChatIdConfigured ?? false}
          envBotConfigured={statusData?.envBotConfigured ?? false}
          telegramOk={telegram?.ok ?? false}
          botApiBackend={statusData?.botApiBackend ?? 'Cloud Bot API (api.telegram.org)'}
          usingLocalBotApi={statusData?.usingLocalBotApi ?? false}
          maxFileUploadBytes={statusData?.maxFileUploadBytes ?? 50 * 1024 * 1024}
          envBotApiUrl={statusData?.envBotApiUrl ?? ''}
          onSaved={() => {
            refetchStatus()
            qc.invalidateQueries({ queryKey: ['telegram-status'] })
          }}
        />

        {/* CLI setup */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="flex items-center gap-2 mb-4">
            <Terminal className="size-4 text-primary" />
            <h3 className="text-sm font-medium">CLI setup</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-3">Install the CLI and log in from your terminal:</p>
          <pre className="font-mono text-[12px] leading-relaxed text-primary/90 bg-background/60 rounded-md p-3 border border-border/40 overflow-x-auto">
{`# install
$ npm i -g onyx-base

# authenticate (point at this hosted server)
$ onyx login --server ${typeof window !== 'undefined' ? window.location.origin : 'https://your-onyx.example.com'} --key ${apiKey?.slice(0, 16) ?? 'kv_live_xxx'}…

# start managing data
$ onyx set coins 500
$ onyx get coins
$ onyx list
$ onyx export`}
          </pre>
          <p className="text-[11px] text-muted-foreground/70 mt-2">
            Your API key authenticates both the dashboard and the CLI. Copy it from the &quot;Current session key&quot; section above.
          </p>
        </Card>

        {/* Danger zone */}
        <Card className="p-5 bg-red-500/5 border-red-400/20">
          <h3 className="text-sm font-medium text-red-700 mb-1">Session</h3>
          <p className="text-xs text-red-600/80 mb-3">Sign out of this dashboard. Your data and API keys are not affected.</p>
          <Button variant="outline" size="sm" onClick={logout} className="border-red-300 text-red-700 hover:bg-red-500/10">
            <LogOut className="size-4" /> Sign out
          </Button>
        </Card>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram chat ID card — lets the user set their OWN chat ID without ever
// touching the bot token (which stays server-side). The bot token is the
// secret; the chat ID is just a destination.
// ─────────────────────────────────────────────────────────────────────────────

function TelegramChatIdCard({
  customConfig,
  envChatIdMasked,
  envChatIdConfigured,
  envBotConfigured,
  telegramOk,
  botApiBackend,
  usingLocalBotApi,
  maxFileUploadBytes,
  envBotApiUrl,
  onSaved,
}: {
  customConfig: { chatId: string; label: string | null; hasCustomBotToken: boolean; botApiBaseUrl: string | null; updatedAt: string } | null
  envChatIdMasked: string
  envChatIdConfigured: boolean
  envBotConfigured: boolean
  telegramOk: boolean
  botApiBackend: string
  usingLocalBotApi: boolean
  maxFileUploadBytes: number
  envBotApiUrl: string
  onSaved: () => void
}) {
  const api = useApi()
  // The chat ID input is intentionally NOT pre-filled from customConfig.chatId
  // (which is now masked server-side). When a custom config exists, the field
  // starts empty with a "type to replace" placeholder so the user never sees
  // a masked value in an editable input.
  const [chatId, setChatId] = useState('')
  const [label, setLabel] = useState(customConfig?.label ?? '')
  const [botToken, setBotToken] = useState('')
  const [botApiUrl, setBotApiUrl] = useState(customConfig?.botApiBaseUrl ?? '')
  const [showBotToken, setShowBotToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [clearing, setClearing] = useState(false)
  const [clearingToken, setClearingToken] = useState(false)
  const [clearingBotApiUrl, setClearingBotApiUrl] = useState(false)
  const hasCustomBotToken = customConfig?.hasCustomBotToken ?? false
  const hasCustomBotApiUrl = Boolean(customConfig?.botApiBaseUrl)

  // Sync local state when the server data loads/changes.
  useEffect(() => {
    if (customConfig) {
      setChatId(customConfig.chatId)
      setLabel(customConfig.label ?? '')
      setBotApiUrl(customConfig.botApiBaseUrl ?? '')
    }
  }, [customConfig])

  async function save() {
    const trimmed = chatId.trim()
    // chatId is optional on save — if empty and a config already exists, the
    // server keeps the existing chat ID (so the user can update just the bot
    // token / label without re-entering the chat ID).
    if (trimmed && !/^-?\d+$/.test(trimmed)) {
      toast.error('Chat ID must be numeric (e.g. -1001234567890)')
      return
    }
    if (!trimmed && !customConfig && !envChatIdConfigured) {
      toast.error('Chat ID is required')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = { label: label.trim() || undefined }
      // Only send chatId when the user typed a new one.
      if (trimmed) body.chatId = trimmed
      // Only send botToken if the user typed something (don't overwrite existing on chat-ID-only saves)
      const trimmedToken = botToken.trim()
      if (trimmedToken) {
        body.botToken = trimmedToken
      }
      // Send botApiBaseUrl so the server can store/clear it. We always send it
      // (even if empty) so the user can clear it by emptying the field — UNLESS
      // they didn't touch the field at all and it matches the existing value.
      const trimmedUrl = botApiUrl.trim()
      if (trimmedUrl !== (customConfig?.botApiBaseUrl ?? '')) {
        body.botApiBaseUrl = trimmedUrl
      }
      await api('/api/dashboard/telegram-config', {
        method: 'PUT',
        body: JSON.stringify(body),
      })
      const msg = trimmedToken
        ? 'Telegram config saved — bot token verified'
        : trimmedUrl !== (customConfig?.botApiBaseUrl ?? '')
          ? trimmedUrl
            ? 'Telegram config saved — local Bot API server URL set'
            : 'Telegram config saved — reverted to cloud Bot API'
          : 'Telegram chat ID saved — connection verified'
      toast.success(msg)
      setBotToken('') // clear the token field after save
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function clearCustom() {
    setClearing(true)
    try {
      await api('/api/dashboard/telegram-config', { method: 'DELETE' })
      toast.success('Reverted to server defaults')
      setChatId('')
      setLabel('')
      setBotToken('')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clear failed')
    } finally {
      setClearing(false)
    }
  }

  async function clearBotTokenOnly() {
    setClearingToken(true)
    try {
      await api('/api/dashboard/telegram-config', {
        method: 'PUT',
        body: JSON.stringify({ clearBotToken: true }),
      })
      toast.success('Custom bot token cleared — using server default')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clear failed')
    } finally {
      setClearingToken(false)
    }
  }

  async function clearBotApiUrlOnly() {
    setClearingBotApiUrl(true)
    try {
      await api('/api/dashboard/telegram-config', {
        method: 'PUT',
        body: JSON.stringify({ clearBotApiUrl: true }),
      })
      setBotApiUrl('')
      toast.success('Custom Bot API URL cleared — using cloud default (50 MB upload limit)')
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Clear failed')
    } finally {
      setClearingBotApiUrl(false)
    }
  }

  return (
    <Card className="p-5 bg-card/40 border-border/60">
      <div className="flex items-center gap-2 mb-4">
        <MessageCircle className="size-4 text-primary" />
        <h3 className="text-sm font-medium">Telegram chat ID</h3>
        {customConfig ? (
          <Badge variant="outline" className="font-mono text-[10px] ml-auto border-primary/30 text-primary">
            custom
          </Badge>
        ) : (
          <Badge variant="outline" className="font-mono text-[10px] ml-auto border-border/60 text-muted-foreground">
            server default
          </Badge>
        )}
      </div>

      {/* Security note */}
      <div className="rounded-md border border-primary/20 bg-primary/5 p-3 mb-4 flex items-start gap-2">
        <ShieldCheck className="size-3.5 text-primary mt-0.5 shrink-0" />
        <p className="text-[11px] text-primary/80 leading-relaxed">
          <strong>Chat ID</strong> is required — it tells the bot <em>where</em> to send messages.
          <strong> Bot token</strong> is optional — provide your own to use your own bot instead of the server default.
          The token is stored server-side only and is never returned to the browser after saving.
        </p>
      </div>

      {/* Current effective config */}
      <div className="grid sm:grid-cols-2 gap-3 mb-4 text-sm">
        <div className="rounded-md border border-border/40 bg-background/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">
            Effective chat ID
          </div>
          <code className="font-mono text-xs text-primary break-all">
            {customConfig?.chatId || envChatIdMasked || '— (not configured)'}
          </code>
        </div>
        <div className="rounded-md border border-border/40 bg-background/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">
            Source
          </div>
          <span className="text-xs">
            {customConfig ? 'Your custom chat ID' : envChatIdConfigured ? 'Server env default' : 'Not set'}
          </span>
        </div>
        <div className="rounded-md border border-border/40 bg-background/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">
            Bot token
          </div>
          <span className="text-xs">
            {hasCustomBotToken ? (
              <span className="text-primary font-medium">Your custom bot token is set</span>
            ) : envBotConfigured ? (
              'Server env default'
            ) : (
              <span className="text-red-600">Not configured — provide your own below</span>
            )}
          </span>
        </div>
        <div className="rounded-md border border-border/40 bg-background/40 p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">
            Bot API backend
          </div>
          <div className="flex items-center gap-1.5">
            <Server className="size-3 text-primary/70" />
            <span className="text-xs font-medium">{botApiBackend}</span>
          </div>
          <div className="text-[10px] text-muted-foreground/60 mt-1">
            Upload limit: <span className="font-mono text-primary/80">{maxFileUploadBytes >= 1024 * 1024 * 1024 ? '2 GB' : '50 MB'}</span>
            {usingLocalBotApi ? ' (local server)' : ' (cloud)'}
          </div>
        </div>
      </div>

      {/* Input form */}
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="tg-chat-id" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Your Telegram chat ID
          </Label>
          <Input
            id="tg-chat-id"
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder={customConfig ? 'Saved — type a new chat ID to replace' : '-1001234567890'}
            className="font-mono text-sm h-9"
          />
          <p className="text-[11px] text-muted-foreground/70">
            Channel/supergroup IDs start with <code className="font-mono">-100</code>. Private chat IDs are positive numbers. Forward a message from your chat to <code className="font-mono">@userinfobot</code> to find it.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tg-label" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Label <span className="text-muted-foreground/50 normal-case">(optional)</span>
          </Label>
          <Input
            id="tg-label"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="My backup channel"
            className="text-sm h-9"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tg-bot-token" className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <Lock className="size-3" /> Bot token <span className="text-muted-foreground/50 normal-case">(optional — use your own bot)</span>
            {hasCustomBotToken && (
              <Badge variant="outline" className="ml-auto font-mono text-[9px] border-primary/30 text-primary">custom</Badge>
            )}
          </Label>
          <div className="relative">
            <Input
              id="tg-bot-token"
              type={showBotToken ? 'text' : 'password'}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={hasCustomBotToken ? '•••••••• (saved — type to replace)' : '123456789:ABCdef...'}
              className="font-mono text-sm h-9 pr-16"
              autoComplete="off"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 h-7 px-2 text-[11px] text-muted-foreground"
              onClick={() => setShowBotToken((v) => !v)}
            >
              {showBotToken ? 'Hide' : 'Show'}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/70">
            Create a bot with <code className="font-mono">@BotFather</code> on Telegram, then paste its token here.
            Your writes will use this bot instead of the server default. Leave blank to keep the existing token.
          </p>
          {hasCustomBotToken && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clearBotTokenOnly}
              disabled={clearingToken}
              className="text-[11px] h-7 px-2 text-muted-foreground hover:text-red-600"
            >
              {clearingToken ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              Clear custom bot token
            </Button>
          )}
        </div>
        {/* ─── Custom local Bot API server URL (optional — unlocks 2 GB files) ─── */}
        <div className="space-y-1.5 pt-2 border-t border-border/40">
          <Label htmlFor="tg-bot-api-url" className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-1.5">
            <HardDrive className="size-3" /> Local Bot API server URL <span className="text-muted-foreground/50 normal-case">(optional — for files up to 2 GB)</span>
            {hasCustomBotApiUrl && (
              <Badge variant="outline" className="ml-auto font-mono text-[9px] border-primary/30 text-primary">custom</Badge>
            )}
          </Label>
          <Input
            id="tg-bot-api-url"
            value={botApiUrl}
            onChange={(e) => setBotApiUrl(e.target.value)}
            placeholder="http://localhost:8081"
            className="font-mono text-sm h-9"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
            The cloud Bot API (<code className="font-mono">api.telegram.org</code>) caps uploads at <strong>50 MB</strong> and downloads at <strong>20 MB</strong>.
            Running your own <a className="underline text-primary/80" href="https://github.com/tdlib/telegram-bot-api" target="_blank" rel="noreferrer">local Bot API server</a> raises both limits to <strong>2 GB</strong>.
            Enter its base URL here to route ALL file operations through your server instead of the cloud.
            Leave empty to use the cloud default.
          </p>
          {envBotApiUrl && !hasCustomBotApiUrl && (
            <p className="text-[10px] text-muted-foreground/60">
              Server operator has set a default: <code className="font-mono">{envBotApiUrl}</code>
            </p>
          )}
          {hasCustomBotApiUrl && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={clearBotApiUrlOnly}
              disabled={clearingBotApiUrl}
              className="text-[11px] h-7 px-2 text-muted-foreground hover:text-red-600"
            >
              {clearingBotApiUrl ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
              Clear custom Bot API URL
            </Button>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={save}
            disabled={saving || !chatId.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save & verify
          </Button>
          {customConfig && (
            <Button
              size="sm"
              variant="outline"
              onClick={clearCustom}
              disabled={clearing}
              className="border-border/60 text-muted-foreground hover:text-red-600 hover:border-red-400/30"
            >
              {clearing ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
              Revert to default
            </Button>
          )}
          {telegramOk ? (
            <span className="text-[11px] text-primary/80 flex items-center gap-1">
              <CheckCircle2 className="size-3" /> Connected
            </span>
          ) : null}
        </div>
      </div>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground/70 mb-1">{label}</div>
      <div className="text-sm">{value}</div>
    </div>
  )
}

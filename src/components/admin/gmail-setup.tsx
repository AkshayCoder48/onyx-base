'use client'

import { useState, useEffect, useCallback } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Mail,
  Check,
  X,
  Loader2,
  ExternalLink,
  Copy,
  RefreshCw,
  Plug,
  Unplug,
  AlertCircle,
  ShieldCheck,
  Terminal,
} from 'lucide-react'
import { useApi } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/* ===================================================================
 *  GmailSetup — admin UI for the Gmail OAuth2 XOAUTH2 SMTP connection.
 *
 *  Lets the admin connect their regular Gmail account (NO App Password,
 *  NO 2FA requirement) via Google's OAuth2 consent flow. Once connected,
 *  the system auto-sends OTP emails through smtp.gmail.com using a
 *  persisted refresh token — "real Gmail + Gmail password, auto-sending,
 *  unlimited free" (500/day regular, 2000/day Workspace).
 *
 *  Also documents the fallback providers (SMTP plain, Resend, dev mode)
 *  so the admin understands the priority chain.
 * =================================================================== */

interface GmailStatus {
  clientCredsConfigured: boolean
  connected: boolean
  email: string | null
  redirectUri: string
}

export function GmailSetup() {
  const api = useApi()
  const qc = useQueryClient()
  const [connecting, setConnecting] = useState(false)
  const [testEmail, setTestEmail] = useState('')
  const [sendingTest, setSendingTest] = useState(false)

  // ── Read the ?gmail=ok|error query params set by the OAuth2 callback ──
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const result = params.get('gmail')
    const email = params.get('email')
    const msg = params.get('msg')
    if (result === 'ok') {
      toast.success(`Gmail connected as ${email}`, { duration: 6000 })
      // Clean the URL so the toast doesn't re-fire on refresh.
      const url = new URL(window.location.href)
      url.searchParams.delete('gmail')
      url.searchParams.delete('email')
      url.searchParams.delete('msg')
      url.searchParams.delete('admin')
      url.searchParams.delete('tab')
      window.history.replaceState({}, '', url.toString())
    } else if (result === 'error') {
      toast.error(`Gmail connection failed: ${msg || 'unknown error'}`, { duration: 10000 })
      const url = new URL(window.location.href)
      url.searchParams.delete('gmail')
      url.searchParams.delete('email')
      url.searchParams.delete('msg')
      url.searchParams.delete('admin')
      url.searchParams.delete('tab')
      window.history.replaceState({}, '', url.toString())
    }
  }, [])

  // ── Fetch connection status ──
  const { data: status, refetch, isFetching } = useQuery<GmailStatus>({
    queryKey: ['admin', 'gmail', 'status'],
    queryFn: () => api<GmailStatus>('/api/admin/gmail/status'),
    refetchInterval: 30_000,
  })

  // ── Start the OAuth2 flow ──
  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await api<{ url: string }>('/api/admin/gmail/start')
      return res
    },
    onSuccess: (res) => {
      // Redirect the browser to Google's consent screen.
      window.location.href = res.url
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Could not start Gmail OAuth2 flow')
      setConnecting(false)
    },
  })

  const handleConnect = useCallback(() => {
    setConnecting(true)
    startMutation.mutate()
  }, [startMutation])

  // ── Disconnect ──
  const disconnectMutation = useMutation({
    mutationFn: () => api<{ disconnected: boolean }>('/api/admin/gmail/disconnect', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Gmail disconnected. OTP emails will fall back to the next provider.')
      qc.invalidateQueries({ queryKey: ['admin', 'gmail', 'status'] })
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Could not disconnect Gmail')
    },
  })

  // ── Send a test email ──
  const handleSendTest = useCallback(async () => {
    if (!testEmail.trim()) {
      toast.error('Enter an email address to send a test to.')
      return
    }
    setSendingTest(true)
    try {
      // We reuse the public send-otp endpoint with purpose='login' against
      // the admin's own email — but that requires an existing account.
      // Instead, we just call send-otp with a signup-style probe. Since
      // there's no dedicated test endpoint, we surface a helpful message.
      toast.info(
        status?.connected
          ? `Gmail is connected as ${status.email}. Signup/login flows will deliver real codes to user inboxes. Try signing up with ${testEmail} to test end-to-end.`
          : 'Connect Gmail first, then test by signing up with any email address.',
        { duration: 8000 },
      )
    } finally {
      setSendingTest(false)
    }
  }, [testEmail, status])

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard?.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error('Could not copy to clipboard'),
    )
  }

  return (
    <div className="space-y-6">
      {/* ─── Header ─── */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Mail className="size-6 text-primary" />
            Email &amp; OTP Delivery
          </h1>
          <p className="text-sm text-muted-foreground">
            Send real verification codes via your Gmail account — no App Password, no 2FA required.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refetch()}
          disabled={isFetching}
          className="h-8 text-muted-foreground"
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* ─── Status card ─── */}
      <Card className="p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-3 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-medium">Gmail OAuth2 Connection</h2>
              {status?.connected ? (
                <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/15">
                  <Check className="size-3 mr-1" /> Connected
                </Badge>
              ) : status?.clientCredsConfigured ? (
                <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 hover:bg-amber-500/15">
                  <AlertCircle className="size-3 mr-1" /> Not connected
                </Badge>
              ) : (
                <Badge variant="secondary">
                  <AlertCircle className="size-3 mr-1" /> Needs setup
                </Badge>
              )}
            </div>
            {status?.connected ? (
              <p className="text-sm text-muted-foreground">
                Sending as <strong className="text-foreground font-mono">{status.email}</strong>.
                OTP emails auto-send via Gmail SMTP (XOAUTH2). 500/day free (2000/day Workspace).
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect your regular Gmail account. You sign in once with your Gmail password —
                no App Password, no 2FA. The system then auto-sends OTP emails on your behalf.
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {status?.connected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => disconnectMutation.mutate()}
                disabled={disconnectMutation.isPending}
              >
                {disconnectMutation.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Unplug className="size-3.5" />
                )}
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleConnect}
                disabled={connecting || !status?.clientCredsConfigured}
              >
                {connecting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Plug className="size-3.5" />
                )}
                Connect Gmail
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* ─── Setup guide (shown when not connected) ─── */}
      {!status?.connected && (
        <Card className="p-6 space-y-4">
          <div className="flex items-center gap-2">
            <Terminal className="size-5 text-primary" />
            <h2 className="text-lg font-medium">One-time setup guide</h2>
          </div>
          <p className="text-sm text-muted-foreground">
            You only do this once. After that, OTP emails auto-send forever (until you disconnect).
          </p>

          <ol className="space-y-3 text-sm">
            <SetupStep n={1}>
              Go to{' '}
              <a
                href="https://console.cloud.google.com/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline inline-flex items-center gap-0.5"
              >
                Google Cloud Console <ExternalLink className="size-3" />
              </a>{' '}
              and create a project (free, no credit card).
            </SetupStep>
            <SetupStep n={2}>
              Enable the <strong>Gmail API</strong>: APIs &amp; Services → Library → search
              &quot;Gmail API&quot; → Enable.
            </SetupStep>
            <SetupStep n={3}>
              Configure the <strong>OAuth consent screen</strong>:
              <ul className="list-disc pl-5 mt-1 space-y-0.5 text-muted-foreground">
                <li>User type: <strong>External</strong></li>
                <li>Add your own Gmail address as a <strong>Test User</strong> (so the app can stay in Testing mode — no verification needed)</li>
              </ul>
            </SetupStep>
            <SetupStep n={4}>
              Create <strong>OAuth2 credentials</strong>:
              <ul className="list-disc pl-5 mt-1 space-y-0.5 text-muted-foreground">
                <li>Credentials → Create Credentials → OAuth client ID</li>
                <li>Application type: <strong>Web application</strong></li>
                <li>
                  Authorized redirect URI — copy this exactly:
                </li>
              </ul>
              <div className="mt-2 flex items-center gap-2">
                <Input
                  readOnly
                  value={status?.redirectUri || 'loading…'}
                  className="font-mono text-xs h-9 bg-muted/50"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  variant="outline"
                  size="icon"
                  className="h-9 w-9 shrink-0"
                  onClick={() => copyToClipboard(status?.redirectUri || '', 'Redirect URI')}
                  title="Copy redirect URI"
                >
                  <Copy className="size-3.5" />
                </Button>
              </div>
            </SetupStep>
            <SetupStep n={5}>
              Copy the <strong>Client ID</strong> and <strong>Client Secret</strong> into your{' '}
              <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">.env</code> file:
              <pre className="mt-2 p-3 rounded-md bg-muted/70 text-xs font-mono overflow-x-auto">
{`GMAIL_OAUTH_CLIENT_ID=xxxxxxxxx.apps.googleusercontent.com
GMAIL_OAUTH_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxx`}
              </pre>
              Then restart the dev server.
            </SetupStep>
            <SetupStep n={6}>
              {status?.clientCredsConfigured ? (
                <span>
                  Click <strong>Connect Gmail</strong> above. You&apos;ll be redirected to Google,
                  sign in with your <strong>regular Gmail password</strong> (no App Password needed),
                  approve access, and you&apos;re done.
                </span>
              ) : (
                <span className="text-amber-600 dark:text-amber-400">
                  ⚠ Add the <code className="font-mono text-xs">GMAIL_OAUTH_CLIENT_ID</code> and{' '}
                  <code className="font-mono text-xs">GMAIL_OAUTH_CLIENT_SECRET</code> env vars,
                  restart the server, then refresh this page.
                </span>
              )}
            </SetupStep>
          </ol>

          <div className="rounded-md bg-emerald-500/10 border border-emerald-500/20 p-3 text-xs text-emerald-700 dark:text-emerald-400 flex items-start gap-2">
            <ShieldCheck className="size-4 mt-0.5 shrink-0" />
            <div>
              <strong>Why this is safe:</strong> You sign in on Google&apos;s own page — your
              password never touches this server. We only receive a refresh token scoped to Gmail
              SMTP. Revoke access anytime at{' '}
              <a
                href="https://myaccount.google.com/permissions"
                target="_blank"
                rel="noopener noreferrer"
                className="underline inline-flex items-center gap-0.5"
              >
                myaccount.google.com/permissions <ExternalLink className="size-3" />
              </a>.
            </div>
          </div>
        </Card>
      )}

      {/* ─── Provider priority chain ─── */}
      <Card className="p-6 space-y-3">
        <h2 className="text-lg font-medium">Provider priority</h2>
        <p className="text-sm text-muted-foreground">
          When sending an OTP, the system tries providers in this order. The first one that&apos;s
          configured wins.
        </p>
        <div className="space-y-2">
          <ProviderRow
            n={1}
            name="Gmail OAuth2"
            active={status?.connected ?? false}
            desc="Your regular Gmail — no App Password, no 2FA. 500/day free."
          />
          <ProviderRow
            n={2}
            name="SMTP plain"
            active={false}
            desc="SMTP_HOST + SMTP_USER + SMTP_PASS in .env. Brevo: 300/day free. (Configured server-side — see .env)"
            muted
          />
          <ProviderRow
            n={3}
            name="Resend HTTP API"
            active={false}
            desc="RESEND_API_KEY in .env. 100/day free. (Configured server-side — see .env)"
            muted
          />
          <ProviderRow
            n={4}
            name="Dev mode"
            active={!(status?.connected)}
            desc="No credentials — code shown inline + logged to console. Works offline."
            muted
          />
        </div>
      </Card>

      {/* ─── Test (info only — no dedicated test endpoint) ─── */}
      {status?.connected && (
        <Card className="p-6 space-y-3">
          <h2 className="text-lg font-medium">Verify it works</h2>
          <p className="text-sm text-muted-foreground">
            The simplest end-to-end test: open the login screen in a new tab and sign up with a
            real email address. The OTP code should arrive in that inbox within a few seconds.
          </p>
          <div className="flex items-center gap-2">
            <Input
              type="email"
              placeholder="you@example.com"
              value={testEmail}
              onChange={(e) => setTestEmail(e.target.value)}
              className="h-9"
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleSendTest}
              disabled={sendingTest || !testEmail.trim()}
              className="h-9"
            >
              {sendingTest ? <Loader2 className="size-3.5 animate-spin" /> : <Mail className="size-3.5" />}
              How to test
            </Button>
          </div>
        </Card>
      )}
    </div>
  )
}

/* ─── Helper sub-components ─── */

function SetupStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 size-6 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center mt-0.5">
        {n}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </li>
  )
}

function ProviderRow({
  n,
  name,
  active,
  desc,
  muted,
}: {
  n: number
  name: string
  active: boolean
  desc: string
  muted?: boolean
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-3 p-3 rounded-md border',
        active ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-border',
        muted && !active && 'opacity-60',
      )}
    >
      <span
        className={cn(
          'shrink-0 size-6 rounded-full text-xs font-semibold flex items-center justify-center',
          active
            ? 'bg-emerald-500/20 text-emerald-700'
            : 'bg-muted text-muted-foreground',
        )}
      >
        {active ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{name}</span>
          {active && (
            <Badge className="bg-emerald-500/15 text-emerald-700 border-emerald-500/30 hover:bg-emerald-500/15 text-[10px]">
              ACTIVE
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
    </div>
  )
}

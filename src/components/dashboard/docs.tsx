'use client'

import { useState } from 'react'
import {
  BookOpen,
  Copy,
  Check,
  Terminal,
  Code2,
  Globe,
  Server,
  Key,
  KeyRound,
  ShieldCheck,
  HardDrive,
  Database,
  Sparkles,
  LayoutDashboard,
  FolderTree,
  Share2,
  ScrollText,
  BarChart3,
  TerminalSquare,
  Settings,
  Zap,
  Radio,
  LifeBuoy,
  Download,
  FileDown,
  Clock,
  Lock,
  Trash2,
  RefreshCw,
  Cpu,
} from 'lucide-react'
import { PageHeader } from './shell'
import { useOnyxBase } from '@/lib/store'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'

// ─────────────────────────────────────────────────────────────────────────────
// Code block with copy button + language label
// ─────────────────────────────────────────────────────────────────────────────

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast.success('Copied')
    } catch {
      toast.error('Copy failed')
    }
  }
  return (
    <div className="relative rounded-lg border border-border/60 bg-stone-900 group">
      <div className="flex items-center justify-between px-3 py-2 border-b border-white/10">
        <span className="text-[10px] font-mono uppercase tracking-wider text-stone-400">{lang}</span>
        <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[11px] text-stone-300 hover:text-white hover:bg-white/10 opacity-70 group-hover:opacity-100" onClick={copy}>
          {copied ? <><Check className="size-3 mr-1" /> Copied</> : <><Copy className="size-3 mr-1" /> Copy</>}
        </Button>
      </div>
      <pre className="font-mono text-[12px] leading-relaxed text-stone-100 px-4 py-3 overflow-x-auto scroll-slim max-h-[420px]">
        <code>{code}</code>
      </pre>
    </div>
  )
}

// Multi-language tabs for a single operation
function MultiLangCode({ samples }: { samples: { lang: string; label: string; code: string }[] }) {
  return (
    <Tabs defaultValue={samples[0].lang}>
      <div className="overflow-x-auto scroll-slim pb-1 -mx-1 px-1">
        <TabsList className="inline-flex h-9 w-max gap-0.5">
          {samples.map((s) => (
            <TabsTrigger key={s.lang} value={s.lang} className="text-[11px] px-3 py-1.5 whitespace-nowrap">
              {s.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </div>
      {samples.map((s) => (
        <TabsContent key={s.lang} value={s.lang} className="mt-2">
          <CodeBlock code={s.code} lang={s.lang} />
        </TabsContent>
      ))}
    </Tabs>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition row used inside the Keys & Tokens tab
// ─────────────────────────────────────────────────────────────────────────────

function DefRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[140px_minmax(0,1fr)] gap-1 sm:gap-4 py-2 border-b border-border/40 last:border-0">
      <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground/70 self-start sm:pt-0.5">
        {label}
      </div>
      <div className="text-[13px] text-foreground/90 leading-relaxed">{children}</div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint card
// ─────────────────────────────────────────────────────────────────────────────

function EndpointCard({
  method,
  path,
  title,
  description,
  auth,
  children,
}: {
  method: 'GET' | 'POST' | 'DELETE'
  path: string
  title: string
  description: string
  auth?: string
  children?: React.ReactNode
}) {
  const methodColor =
    method === 'GET' ? 'bg-primary/15 text-primary border-primary/30'
    : method === 'POST' ? 'bg-amber-100 text-amber-800 border-amber-300'
    : 'bg-rose-100 text-rose-700 border-rose-300'
  return (
    <div className="rounded-xl border border-border/60 bg-card/30 overflow-hidden">
      <div className="p-4 sm:p-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded border ${methodColor}`}>{method}</span>
          <code className="font-mono text-sm text-foreground break-all">{path}</code>
        </div>
        <div>
          <h3 className="font-semibold text-[15px]">{title}</h3>
          <p className="text-sm text-muted-foreground mt-0.5">{description}</p>
        </div>
        {auth && (
          <div className="flex items-start gap-1.5 text-[12px] text-muted-foreground bg-muted/30 rounded-md px-2.5 py-1.5">
            <Key className="size-3.5 mt-0.5 shrink-0 text-primary" />
            <span><code className="font-mono text-primary">Authorization: Bearer kv_live_…</code> — {auth}</span>
          </div>
        )}
      </div>
      {children && <div className="px-4 sm:px-5 pb-5 space-y-3">{children}</div>}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature card (dashboard tab reference)
// ─────────────────────────────────────────────────────────────────────────────

interface FeatureDef {
  icon: React.ReactNode
  title: string
  body: string
}

function FeatureCard({ icon, title, body }: FeatureDef) {
  return (
    <Card className="p-5 bg-card/40 border-border/60 hover:border-primary/30 transition-colors h-full">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center text-primary shrink-0">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-[15px] tracking-tight">{title}</h3>
          <p className="text-[13px] text-muted-foreground mt-1.5 leading-relaxed">{body}</p>
        </div>
      </div>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Token card (Keys & Tokens tab)
// ─────────────────────────────────────────────────────────────────────────────

interface TokenDef {
  icon: React.ReactNode
  name: string
  format: string
  blurb: string
  mintedAt: string
  scope: string
  lifetime: string
  revocation: string
  example: string
  exampleLang: string
}

function TokenCard(t: TokenDef) {
  return (
    <Card className="p-5 sm:p-6 bg-card/40 border-border/60">
      <div className="flex flex-wrap items-start gap-3 mb-4">
        <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center text-primary shrink-0">
          {t.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-[15px] tracking-tight">{t.name}</h3>
            <Badge variant="outline" className="font-mono text-[11px]">{t.format}</Badge>
          </div>
          <p className="text-[13px] text-muted-foreground mt-1 leading-relaxed">{t.blurb}</p>
        </div>
      </div>

      <div className="rounded-md border border-border/40 bg-muted/20 px-3 sm:px-4 py-1 mb-4">
        <DefRow label="Minted">{t.mintedAt}</DefRow>
        <DefRow label="Scope">{t.scope}</DefRow>
        <DefRow label="Lifetime">{t.lifetime}</DefRow>
        <DefRow label="Revocation">{t.revocation}</DefRow>
      </div>

      <CodeBlock lang={t.exampleLang} code={t.example} />
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Docs view
// ─────────────────────────────────────────────────────────────────────────────

export function DocsView() {
  const apiKey = useOnyxBase((s) => s.apiKey)
  const userId = useOnyxBase((s) => s.user?.userId)
  const maskedKey = apiKey ? `${apiKey.slice(0, 12)}…${apiKey.slice(-4)}` : 'kv_live_xxxxxxxx'
  const keyForCode = apiKey || 'kv_live_YOUR_API_KEY'
  // Use the actual hosted origin — never localhost. Falls back to a relative
  // path (empty string) during SSR; the browser always has window.location.
  const apiBase = typeof window !== 'undefined' ? window.location.origin : ''

  // "Copy for LLMs" — fetches /llms.txt (the llmstxt.org convention) and writes
  // the markdown to the clipboard so a user can paste it straight into an LLM.
  const [llmCopied, setLlmCopied] = useState(false)
  async function copyForLlms() {
    try {
      const r = await fetch('/llms.txt')
      if (!r.ok) throw new Error(`/llms.txt returned ${r.status}`)
      const text = await r.text()
      await navigator.clipboard.writeText(text)
      setLlmCopied(true)
      setTimeout(() => setLlmCopied(false), 2000)
      toast.success('Copied — paste into your favourite LLM')
    } catch {
      toast.error('Copy failed — try fetching /llms.txt directly')
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Docs"
        description="Everything you need to use Onyx Base — keys & tokens, every dashboard feature, the REST API, the CLI, realtime, and Telegram-backed durability."
        actions={
          <Button variant="outline" size="sm" onClick={copyForLlms} className="gap-1.5">
            {llmCopied
              ? <><Check className="size-3.5 text-emerald-600" /> Copied for LLMs</>
              : <><Sparkles className="size-3.5 text-primary" /> Copy for LLMs</>}
          </Button>
        }
      />

      <Tabs defaultValue="overview" className="space-y-6">
        <div className="overflow-x-auto scroll-slim -mx-1 px-1">
          <TabsList className="inline-flex h-10 w-max gap-0.5">
            <TabsTrigger value="overview" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <Globe className="size-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="keys" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <KeyRound className="size-3.5" /> Keys & Tokens
            </TabsTrigger>
            <TabsTrigger value="features" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <Sparkles className="size-3.5" /> Features
            </TabsTrigger>
            <TabsTrigger value="api" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <Server className="size-3.5" /> REST API
            </TabsTrigger>
            <TabsTrigger value="cli" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <Terminal className="size-3.5" /> CLI
            </TabsTrigger>
            <TabsTrigger value="realtime" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <Radio className="size-3.5" /> Realtime
            </TabsTrigger>
            <TabsTrigger value="telegram" className="text-[12px] px-3 whitespace-nowrap gap-1.5">
              <LifeBuoy className="size-3.5" /> Telegram durability
            </TabsTrigger>
          </TabsList>
        </div>

        {/* ───────────────────────── Overview ───────────────────────── */}
        <TabsContent value="overview" className="space-y-5">
          <Card className="p-5 sm:p-6 bg-card/40 border-border/60">
            <div className="flex items-start gap-3 mb-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center text-primary shrink-0">
                <BookOpen className="size-4" />
              </div>
              <div>
                <h2 className="text-lg font-semibold tracking-tight">What is Onyx Base?</h2>
                <p className="text-sm text-muted-foreground mt-0.5">A Supabase-style developer platform with no database to provision.</p>
              </div>
            </div>
            <p className="text-[14px] text-foreground/90 leading-relaxed">
              Onyx Base is a key-value store <strong>and</strong> file store that lives inside Telegram. Every record
              you set, every file you upload, and every API-key mutation is mirrored into a private Telegram chat —
              that mirror is the durable substrate. A fast in-memory + JSON-on-disk index serves reads, a Socket.io
              mini-service pushes <code className="font-mono text-primary">record:changed</code> events to the dashboard
              in real time, and a single REST surface (<code className="font-mono text-primary">/v1/*</code>) plus a
              zero-dependency CLI (<code className="font-mono text-primary">onyx</code>) cover the developer surface.
              You bring a Telegram Bot Token + Chat ID (or just use the built-in server-side bot), and you get an
              unlimited, free database and file store with a real-time web dashboard on top.
            </p>
          </Card>

          <div className="grid sm:grid-cols-3 gap-3">
            <Card className="p-4 bg-primary/5 border-primary/20">
              <Zap className="size-5 text-primary mb-2" />
              <div className="font-semibold text-[14px]">Unlimited & free</div>
              <p className="text-[12.5px] text-muted-foreground mt-1 leading-relaxed">
                No storage caps, no API-call quotas, no collection limits, no &quot;contact sales&quot; wall. The only
                cost is your own Telegram bot — talk to <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-primary hover:underline">@BotFather</a>, it&apos;s free.
              </p>
            </Card>
            <Card className="p-4 bg-primary/5 border-primary/20">
              <LifeBuoy className="size-5 text-primary mb-2" />
              <div className="font-semibold text-[14px]">Telegram-backed</div>
              <p className="text-[12.5px] text-muted-foreground mt-1 leading-relaxed">
                Your full data and audit log live in your Telegram chat. Stop using Onyx Base tomorrow and your database
                is still sitting there, fully readable.
              </p>
            </Card>
            <Card className="p-4 bg-primary/5 border-primary/20">
              <ShieldCheck className="size-5 text-primary mb-2" />
              <div className="font-semibold text-[14px]">Stateless server</div>
              <p className="text-[12.5px] text-muted-foreground mt-1 leading-relaxed">
                The server keeps a fast local index but holds no identity state of its own — every request is
                authenticated via your Bearer API key. Clear your browser session and you&apos;re signed out, no
                server-side logout needed.
              </p>
            </Card>
          </div>

          <Card className="p-5 sm:p-6 bg-card/40 border-border/60">
            <h3 className="font-semibold text-[15px] mb-2">Architecture in one paragraph</h3>
            <p className="text-[13.5px] text-muted-foreground leading-relaxed">
              <strong className="text-foreground">Clients</strong> (browser dashboard, the <code className="font-mono text-primary">onyx</code> CLI,
              or any HTTP library) talk to a single Next.js API core. The core writes to an in-memory store + a
              JSON-on-disk cache for fast reads, then <strong className="text-foreground">mirrors every mutation</strong>{' '}
              (set / delete / api-key / collection / file upload / share token) into a private Telegram chat as a
              structured message. An identity manifest — the small JSON document that ties your <code className="font-mono text-primary">userId</code> to
              your <code className="font-mono text-primary">apiKey</code> hash and collection list — is <strong className="text-foreground">pinned</strong>{' '}
              to the chat after every identity mutation, which is what lets the platform self-heal after a full reset. A
              Socket.io mini-service (port 3003) fans <code className="font-mono text-primary">record:changed</code> events out to
              every connected dashboard so the UI updates without polling.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-mono text-muted-foreground/80">
              <Badge variant="outline" className="border-primary/30 text-primary">browser</Badge>
              <span>·</span>
              <Badge variant="outline" className="border-primary/30 text-primary">CLI</Badge>
              <span>·</span>
              <Badge variant="outline" className="border-primary/30 text-primary">HTTP</Badge>
              <span className="mx-1">→</span>
              <Badge variant="outline">Next.js API core</Badge>
              <span className="mx-1">→</span>
              <Badge variant="outline">in-memory + JSON index</Badge>
              <span>+</span>
              <Badge variant="outline">Telegram mirror</Badge>
              <span>+</span>
              <Badge variant="outline">Socket.io</Badge>
            </div>
          </Card>
        </TabsContent>

        {/* ───────────────────────── Keys & Tokens ───────────────────────── */}
        <TabsContent value="keys" className="space-y-5">
          <Card className="p-4 bg-primary/5 border-primary/20">
            <div className="flex gap-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0">
                <KeyRound className="size-4 text-primary" />
              </div>
              <div className="text-sm space-y-1.5">
                <p className="font-medium text-foreground">Three credential types, three threat models</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  Onyx Base uses three distinct token types — your master <strong>API key</strong> (full access, never
                  public), scoped <strong>share tokens</strong> (safe in public HTML), and short-lived signed{' '}
                  <strong>download tokens</strong> (per-file, ~1 hour). Each one is minted, scoped, and revoked
                  independently. Treat them like different keys on your keyring: the API key opens the front door, share
                  tokens are the spare that only works on the garage, download tokens are an AirBnB-style temporary
                  code that expires by itself.
                </p>
              </div>
            </div>
          </Card>

          {/* API key */}
          <TokenCard
            icon={<KeyRound className="size-4" />}
            name="API Key"
            format="kv_live_…"
            blurb="Your master credential. The Bearer token used by the dashboard, the CLI, and every REST call. Grants full read/write access to everything you own."
            mintedAt="Minted in the dashboard → API Keys tab (or returned once at signup). Shown exactly once at creation — copy it before closing the dialog."
            scope="Full account access: every collection, every key, every file, every share token, every log. Not scoped — it is you."
            lifetime="No expiry. Lives until you revoke it. Stored as a salted hash on the server; the plaintext is only ever shown once."
            revocation="Revoke instantly from the API Keys tab (DELETE /api/dashboard/api-keys/:id). The key stops authenticating on the very next request."
            exampleLang="http"
            example={`# Every /v1/* and /api/dashboard/* request carries this header:
Authorization: Bearer ${keyForCode}

# Example: set a value
curl -X POST ${apiBase}/v1/set \\
  -H "Authorization: Bearer ${keyForCode}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"coins","value":500}'`}
          />

          {/* Self-healing note for the API key */}
          <Card className="p-4 bg-card/40 border-border/60">
            <div className="flex gap-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center shrink-0">
                <RefreshCw className="size-4 text-primary" />
              </div>
              <div className="text-sm space-y-1.5">
                <p className="font-medium text-foreground">Survives a full local-store wipe</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  Your API key still works even if the server&apos;s local database and JSON cache are completely wiped.
                  On a cache-miss, the auth layer fetches the <strong>pinned identity manifest</strong> from Telegram,
                  rehydrates your user + API key records into the local store, and retries — all transparently. The
                  manifest lives in Telegram; the key matches it; you authenticate. See the <em>Telegram durability</em>{' '}
                  tab for the full self-healing flow.
                </p>
              </div>
            </div>
          </Card>

          {/* Share token */}
          <TokenCard
            icon={<Share2 className="size-4" />}
            name="Share Token"
            format="st_…"
            blurb="A public, scoped, rate-limited, expiring, revocable credential that wraps exactly one (collection, key) pair. Safe to embed in source-visible HTML (CodePen, static sites, browser extensions)."
            mintedAt="Minted in the dashboard → Public Share tab (POST /api/dashboard/share-tokens). Choose mode (read / write / readwrite), allowed ops, rate limit, and TTL."
            scope="One (collection, key) pair. A read token can only read that one key; a write token can only mutate that one key. It cannot touch anything else in your account."
            lifetime="Optional TTL (in minutes). No TTL = never expires. Rate-limited per IP, per minute. Revoke at any time."
            revocation="Revoke instantly from the Public Share tab (DELETE /api/dashboard/share-tokens/:id). The public URL returns 404 on the very next request. Cannot be undone — create a new token and update your HTML."
            exampleLang="http"
            example={`# Read token (mode: read) — public, no auth header
curl ${apiBase}/v1/share/st_YOUR_READ_TOKEN
# → {"ok":true,"key":"visits","value":42,"type":"number"}

# Write token (mode: write, allowedOps: ["incr"]) — public, no auth
curl -X POST ${apiBase}/v1/write/st_YOUR_WRITE_TOKEN \\
  -H "Content-Type: application/json" \\
  -d '{"op":"incr","amount":1}'
# → {"ok":true,"op":"incr","value":43,"previous":42,"type":"number"}`}
          />

          {/* Share token modes & options */}
          <Card className="p-5 sm:p-6 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-3">
              <ShieldCheck className="size-4 text-primary" />
              <h3 className="font-semibold text-[15px]">Share token modes & options</h3>
            </div>
            <div className="grid sm:grid-cols-3 gap-3 mb-4">
              <div className="rounded-md border border-sky-300/60 bg-sky-100/40 p-3">
                <Badge variant="outline" className="border-sky-300 bg-sky-100 text-sky-800 uppercase text-[10px]">Read</Badge>
                <p className="text-[12px] text-muted-foreground mt-2 leading-relaxed">
                  <code className="font-mono">GET /v1/share/:token</code>. Returns the value, type, and updatedAt. Cannot mutate. Pairs with a separate write token if you need both.
                </p>
              </div>
              <div className="rounded-md border border-amber-300/60 bg-amber-100/40 p-3">
                <Badge variant="outline" className="border-amber-300 bg-amber-100 text-amber-800 uppercase text-[10px]">Write</Badge>
                <p className="text-[12px] text-muted-foreground mt-2 leading-relaxed">
                  <code className="font-mono">POST /v1/write/:token</code>. Mutate only — set / incr / append. Cannot read the value back. Use a second read token for that.
                </p>
              </div>
              <div className="rounded-md border border-primary/30 bg-primary/10 p-3">
                <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary uppercase text-[10px]">Read + Write</Badge>
                <p className="text-[12px] text-muted-foreground mt-2 leading-relaxed">
                  Both endpoints work. Convenient for embedded widgets that read AND mutate (e.g. a vote button that increments and displays the new count).
                </p>
              </div>
            </div>
            <div className="rounded-md border border-border/40 bg-muted/20 px-4 py-1">
              <DefRow label="Allowed ops">
                <code className="font-mono text-primary">set</code>, <code className="font-mono text-primary">incr</code>,{' '}
                <code className="font-mono text-primary">append</code>. Pick any subset for write modes. An incr-only
                token can&apos;t overwrite the value.
              </DefRow>
              <DefRow label="Max value length">
                Caps the byte length of <code className="font-mono">set</code> and <code className="font-mono">append</code> bodies.
                Default <code className="font-mono">4096</code>; <code className="font-mono">0</code> = unlimited.
              </DefRow>
              <DefRow label="Incr bounds">
                <code className="font-mono text-primary">incrMin</code> / <code className="font-mono text-primary">incrMax</code> clamp
                the result of <code className="font-mono">incr</code> so a runaway counter can&apos;t escape its range.
              </DefRow>
              <DefRow label="Rate limit">
                Per-IP, per-minute. <code className="font-mono">0</code> or unset = unlimited. Default <code className="font-mono">30</code>.
              </DefRow>
              <DefRow label="TTL">
                Minutes until the token auto-disables. <code className="font-mono">0</code> or unset = never. After
                expiry, the public URL returns <code className="font-mono">410 Gone</code>.
              </DefRow>
              <DefRow label="URLs">
                Each token comes with a <code className="font-mono text-primary">readUrl</code> (for read / readwrite
                modes) and a <code className="font-mono text-primary">writeUrl</code> (for write / readwrite modes) —
                copy-paste-ready.
              </DefRow>
            </div>
          </Card>

          {/* Download token */}
          <TokenCard
            icon={<FileDown className="size-4" />}
            name="Download Token"
            format="expiresAt.sig (HMAC-SHA256)"
            blurb="A signed, 55-minute, per-file token that lets anyone holding the link download one specific file — public or private. The signature IS the credential."
            mintedAt="Auto-minted when you click 'Get link' on a file row (POST /v1/files/:id/link or /api/files/:id/link). Returned alongside the Telegram cloud URL and the proxy URL."
            scope="Exactly one file (by its internal fileId). Cannot be used to download any other file, list files, or read KV data."
            lifetime="55 minutes (just under Telegram's ~1-hour getFile URL expiry). Never auto-refreshed — the user must click 'Get link' again after expiry."
            revocation="Revoke drops the cached Telegram URL on our side (POST /v1/files/:id/revoke). The signature itself can't be revoked, but the underlying Telegram getFile URL it points at expires on its own ~1-hour clock."
            exampleLang="http"
            example={`# Click "Get link" on a file → returns a signed URL on your origin:
#   https://${typeof window !== 'undefined' ? window.location.host : 'your-app'}/f/f_a1b2c3...?t=1735900000000.7e3a9f...&e=1735900000000

# Anyone with the URL can download the file — no auth header:
curl -L -o report.pdf \\
  "${apiBase}/f/f_a1b2c3...?t=1735900000000.7e3a9f...&e=1735900000000"

# After 55 minutes the signature is rejected. Re-click "Get link".`}
          />

          <Card className="p-4 bg-card/40 border-border/60">
            <div className="flex gap-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center shrink-0">
                <Lock className="size-4 text-primary" />
              </div>
              <div className="text-sm space-y-1.5">
                <p className="font-medium text-foreground">Why the signature is the credential</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  The token is <code className="font-mono">{`<expiresAt>.<HMAC-SHA256(fileId:expiresAt, CLOUDKV_SECRET)>`}</code>.
                  The server verifies the HMAC with a constant-time comparison and checks the expiry — no database
                  lookup, no session. That means the link works for <strong>both public and private files</strong>{' '}
                  (the signature is the credential, not the file&apos;s visibility flag), works from anywhere in the
                  world, and never exposes the Telegram bot token (the URL is on your origin; the server proxies the
                  bytes out of Telegram behind the scenes using a cached getFile URL).
                </p>
              </div>
            </div>
          </Card>

          {/* ─── Session sub-section ─── */}
          <Card className="p-5 sm:p-6 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-4">
              <Cpu className="size-4 text-primary" />
              <div>
                <h3 className="font-semibold text-[15px]">Session — <code className="font-mono text-[13px] text-primary">cloudkv-session</code></h3>
                <p className="text-[12.5px] text-muted-foreground mt-0.5">The browser-side session store. The server is stateless.</p>
              </div>
            </div>

            <p className="text-[13.5px] text-foreground/90 leading-relaxed mb-3">
              The dashboard stores your session in <code className="font-mono text-primary">localStorage</code> under the
              key <code className="font-mono text-primary">cloudkv-session</code> — a Zustand-persisted store. It
              contains:
            </p>

            <div className="rounded-md border border-border/40 bg-muted/20 px-4 py-1 mb-4">
              <DefRow label="apiKey">
                Your <code className="font-mono text-primary">kv_live_…</code> master API key. Sent as the Bearer header
                on every dashboard request.
              </DefRow>
              <DefRow label="user">
                Your profile: <code className="font-mono">userId</code>, <code className="font-mono">name</code>,{' '}
                <code className="font-mono">plan</code>, <code className="font-mono">counts</code>{' '}
                (records / collections / apiKeys / logs), and <code className="font-mono">isAdmin</code>.
              </DefRow>
              <DefRow label="activeView">
                Which dashboard tab you&apos;re on (<code className="font-mono">overview</code>,{' '}
                <code className="font-mono">database</code>, <code className="font-mono">collections</code>, …). Persists
                across reloads.
              </DefRow>
              <DefRow label="activeCollection">
                The currently-selected collection (defaults to <code className="font-mono">default</code>).
              </DefRow>
              <DefRow label="useAdminMode">
                <code className="font-mono">true</code> when an admin user wants the admin console;{' '}
                <code className="font-mono">false</code> for the regular dashboard. Only meaningful when{' '}
                <code className="font-mono">user.isAdmin</code> is true.
              </DefRow>
            </div>

            <div className="rounded-md border border-primary/20 bg-primary/5 p-4 space-y-2">
              <p className="text-[13px] text-foreground">
                <strong>This is a LOCAL session.</strong> The server has no session table, no session cookie, no
                &quot;logged in users&quot; list. Every request is authenticated statelessly via the Bearer API key
                header. That means:
              </p>
              <ul className="text-[13px] text-muted-foreground space-y-1.5 list-disc pl-5">
                <li><strong className="text-foreground">Clearing <code className="font-mono">localStorage</code> = signed out.</strong> There is no server-side logout endpoint because there is no server-side session.</li>
                <li><strong className="text-foreground">The session never leaves the browser.</strong> Only the API key travels in the Authorization header on each request — the rest of the session state (activeView, activeCollection, useAdminMode) is purely client-side UI state.</li>
                <li><strong className="text-foreground">Signing out</strong> calls <code className="font-mono">clearSession()</code>, which wipes <code className="font-mono">apiKey</code>, <code className="font-mono">user</code>, and resets <code className="font-mono">activeView</code> / <code className="font-mono">activeCollection</code> / <code className="font-mono">useAdminMode</code> to defaults.</li>
                <li><strong className="text-foreground">The API key persists in localStorage</strong> across browser restarts. If you share the device, sign out when you&apos;re done. The key itself is still valid on the server until you revoke it from the API Keys tab.</li>
              </ul>
            </div>

            <div className="mt-3">
              <CodeBlock lang="javascript" code={`// Inspecting the session from the browser console:
const session = JSON.parse(localStorage.getItem('cloudkv-session') || '{}')
console.log(session.state)
// → {
//     apiKey: "kv_live_abc123…",
//     user: { userId: "usr_xxx", name: "Ada", plan: "free",
//            counts: { records: 4, collections: 2, apiKeys: 1, logs: 12 },
//            isAdmin: false },
//     activeView: "database",
//     activeCollection: "default",
//     useAdminMode: true
//   }

// Signing out = wipe this one key:
localStorage.removeItem('cloudkv-session')`} />
            </div>
          </Card>
        </TabsContent>

        {/* ───────────────────────── Features ───────────────────────── */}
        <TabsContent value="features" className="space-y-5">
          <Card className="p-4 bg-primary/5 border-primary/20">
            <div className="flex gap-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0">
                <Sparkles className="size-4 text-primary" />
              </div>
              <div className="text-sm space-y-1.5">
                <p className="font-medium text-foreground">Twelve tabs, one platform</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  Every dashboard tab below is a real feature — not a placeholder. The icons match the sidebar exactly
                  so you can flip between this reference and the live UI without context-switching.
                </p>
              </div>
            </div>
          </Card>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <FeatureCard
              icon={<LayoutDashboard className="size-4" />}
              title="Dashboard"
              body="Your landing page: a welcome header, four stat cards (records / collections / files / API keys), a 7-day activity area chart, recent records list, and a quick-jump launcher. Use it as the daily entry point — it surfaces what changed since you last visited and gets you into the database or storage tab in one click."
            />
            <FeatureCard
              icon={<Database className="size-4" />}
              title="Database"
              body="A spreadsheet-style IDE for your key-value data. Browse every record in the active collection, expand JSON cells, edit values inline, create new keys with auto-typing (string / number / boolean / JSON), and delete with a confirmation. Auto-refreshes in real time when other clients (the CLI, the API, a share-token widget) mutate a key — the row updates without a reload."
            />
            <FeatureCard
              icon={<FolderTree className="size-4" />}
              title="Collections"
              body="Group keys into named collections (default, cache, metrics, …). Create, rename, and delete whole collections in one action — deleting a collection also wipes every record inside it and mirrors the deletion to Telegram. Use collections to keep unrelated data (config vs. analytics vs. user state) cleanly separated without a second account."
            />
            <FeatureCard
              icon={<HardDrive className="size-4" />}
              title="Cloud Storage"
              body="A drag-and-drop file manager backed by Telegram. Upload any extension (exe, pdf, png, mp4, zip — anything) up to the effective limit (50 MB cloud Bot API, or 2 GB with a self-hosted local Bot API server). Each file gets a permanent /f/<fileId> proxy URL plus a signed 55-minute download token. Toggle public/private per file; track download counts."
            />
            <FeatureCard
              icon={<KeyRound className="size-4" />}
              title="API Keys"
              body="Mint, name, and revoke multiple kv_live_… API keys per account. Each key is shown exactly once at creation — copy it before closing the dialog. Use named keys to segregate access (e.g. one for production, one for staging, one for the CLI on your laptop); revoke any of them instantly without touching the others. Keys are stored as salted hashes; the plaintext is never retrievable after creation."
            />
            <FeatureCard
              icon={<Share2 className="size-4" />}
              title="Public Share"
              body="Create scoped, rate-limited, expiring, revocable share tokens that wrap exactly one (collection, key) pair. Choose mode (read / write / readwrite), allowed ops (set / incr / append), max value length, incr bounds, per-IP rate limit, and TTL. Each token comes with copy-paste-ready readUrl and writeUrl — safe to embed in CodePen, static HTML, or browser extensions."
            />
            <FeatureCard
              icon={<TerminalSquare className="size-4" />}
              title="API Playground"
              body="An interactive REST explorer: pick an endpoint (set / get / list / delete / files / share-tokens / whoami / stats / logs / …), fill in the parameters, hit Send, and inspect the raw JSON response. Auto-injects your current API key as the Bearer header. Great for prototyping calls before committing them to code, or for debugging why a particular request returns 404."
            />
            <FeatureCard
              icon={<Code2 className="size-4" />}
              title="SQL Editor"
              body="A real SQL console that runs against virtual tables (records, collections, api_keys, logs, users) pre-filtered to your account. Run SELECT / INSERT / UPDATE / DELETE / CREATE / DROP / ALTER statements, plus create your own usr_* tables for custom schemas. 1000-row cap per result, API keys masked in output, ⌘+Enter to run. The fastest way to do bulk updates or exploratory queries."
            />
            <FeatureCard
              icon={<BookOpen className="size-4" />}
              title="Docs"
              body="This tab. A comprehensive, in-app reference covering the architecture, every key and token type, every dashboard feature, the full REST API surface, the CLI, the realtime model, and the Telegram durability story. Use it as a quick lookup while you code — copy buttons on every code block, multi-language examples, and a 'Copy for LLMs' button at the top to grab the whole spec for an AI assistant."
            />
            <FeatureCard
              icon={<ScrollText className="size-4" />}
              title="Logs"
              body="An append-only audit trail of every API event on your account: set, delete, login, apikey.create, share.create, file upload, export, and more. Each entry includes the action, the key/collection touched, the source (dashboard / cli / api / share), and a timestamp. Filter by action type, paginate through history. Every log entry is also mirrored into your Telegram chat as a structured message."
            />
            <FeatureCard
              icon={<BarChart3 className="size-4" />}
              title="Analytics"
              body="Aggregate charts over your account activity: requests per day, top actions, top keys, share-token usage, file-download counts. Useful for spotting usage patterns (e.g. a share token that suddenly spiked traffic, or a key that&apos;s being read far more than written). All data is derived from the same logs table the Logs tab shows — just rolled up."
            />
            <FeatureCard
              icon={<Settings className="size-4" />}
              title="Settings"
              body="Account + storage configuration. View your userId, plan, and API-key counts. Configure your own Telegram bot (Bot Token + Chat ID) to route new KV mirrors and file uploads to your private chat instead of the shared server-side bot. Optionally set a local Bot API server URL to unlock 2 GB file uploads/downloads (vs. the cloud Bot API&apos;s 50 MB upload / 20 MB download cap). Ping the bot to verify the config."
            />
          </div>
        </TabsContent>

        {/* ───────────────────────── REST API ───────────────────────── */}
        <TabsContent value="api" className="space-y-5">
          <Card className="p-5 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-3">
              <Server className="size-4 text-primary" />
              <h3 className="font-semibold text-[15px]">The <code className="font-mono">/v1/*</code> surface</h3>
            </div>
            <p className="text-[13.5px] text-muted-foreground leading-relaxed">
              Every <code className="font-mono">/v1/*</code> route (and every <code className="font-mono">/api/dashboard/*</code>{' '}
              route) requires the Bearer header — except signup, public share, public file download, and health. The same
              key works for the CLI, the dashboard, and any HTTP client.
            </p>
            <div className="mt-3">
              <CodeBlock lang="http" code={`# Auth header pattern (every protected route):
Authorization: Bearer ${keyForCode}

# Your account:
#   userId: ${userId || 'usr_xxxxx'}
#   apiKey: ${maskedKey}`} />
            </div>
          </Card>

          {/* Key-value endpoints */}
          <div className="space-y-3">
            <h4 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/70">Key-value</h4>
            <EndpointCard method="POST" path="/v1/set" title="Set / upsert a value" auth="required" description="Body: { key, value, collection? }. Values are auto-typed (string / number / boolean / JSON).">
              <CodeBlock lang="bash" code={`curl -X POST ${apiBase}/v1/set \\
  -H "Authorization: Bearer ${keyForCode}" \\
  -H "Content-Type: application/json" \\
  -d '{"key":"coins","value":500,"collection":"default"}'`} />
            </EndpointCard>
            <EndpointCard method="GET" path="/v1/get/:key?collection=default" title="Read a value" auth="required" description="Returns { ok, key, value, type, collection, updatedAt }. 404 when the key doesn't exist." />
            <EndpointCard method="DELETE" path="/v1/delete/:key?collection=default" title="Delete a value" auth="required" description="Removes the key + its Telegram mirror message. 404 when the key doesn't exist." />
            <EndpointCard method="GET" path="/v1/list?collection=default" title="List keys" auth="required" description="Returns { ok, keys: string[], count, collection }. Use /v1/export if you need the values too." />
            <EndpointCard method="GET" path="/v1/export?collection=default" title="Export as JSON" auth="required" description="Returns { ok, data: { key: value, … } }. Non-default collections are prefixed with the collection name + a dot." />
          </div>

          {/* Files endpoints */}
          <div className="space-y-3">
            <h4 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/70">Files</h4>
            <EndpointCard method="POST" path="/v1/files" title="Upload a file" auth="required" description="multipart/form-data: file (required), label (optional), public (optional, 'true'|'false', default true). Returns the file metadata with a permanent /f/<fileId> URL.">
              <CodeBlock lang="bash" code={`curl -X POST "${apiBase}/v1/files" \\
  -H "Authorization: Bearer ${keyForCode}" \\
  -F "file=@./report.pdf" \\
  -F "label=Q3 report"`} />
            </EndpointCard>
            <EndpointCard method="GET" path="/v1/files" title="List files" auth="required" description="Returns every file you own with its permanent link, size, label, public flag, and download count. Also returns the effective maxFileUploadBytes (50 MB cloud / 2 GB local)." />
            <EndpointCard method="GET" path="/v1/files/:id" title="File metadata" auth="required" description="Single file's metadata. Use /v1/files/:id/link to mint a download URL." />
            <EndpointCard method="POST" path="/v1/files/:id/link" title="Mint a download link" auth="required" description="Mints a signed 55-minute download token. Returns { url, proxyUrl, expiresAt, expiresInSec, revocable }. Add ?force=1 to bypass the 55-min server cache." />
            <EndpointCard method="POST" path="/v1/files/:id/revoke" title="Revoke the cached link" auth="required" description="Drops the cached Telegram getFile URL on our side. The next /link call pulls a brand-new URL. (Telegram's own URL remains valid until its natural ~1-hour expiry.)" />
            <EndpointCard method="DELETE" path="/v1/files/:id" title="Permanently delete a file" auth="required" description="Deletes the file record AND the underlying Telegram document message. Cannot be undone." />
            <EndpointCard method="GET" path="/f/:fileId?t=…&e=…" title="Public download proxy" auth="none (signature is the credential)" description="Streams the file bytes from Telegram through your server's origin. Works for both public and private files when the signature is valid. Add ?inline=1 to render in-browser instead of forcing a download." />
          </div>

          {/* Collections endpoints */}
          <div className="space-y-3">
            <h4 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/70">Collections</h4>
            <EndpointCard method="GET" path="/v1/collections" title="List collections" auth="required" description="Returns every collection with its record count." />
            <EndpointCard method="GET" path="/v1/collections/:name" title="Collection detail" auth="required" description="Returns metadata for one collection." />
          </div>

          {/* Account & ops endpoints */}
          <div className="space-y-3">
            <h4 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/70">Account & ops</h4>
            <EndpointCard method="GET" path="/v1/whoami" title="Who am I?" auth="required" description="Returns { userId, apiKeyId, apiKeyName, isAdmin }. Use this to verify a key is still valid." />
            <EndpointCard method="GET" path="/v1/health" title="Service + Telegram status" auth="none" description="Liveness + readiness probe. Returns whether the in-memory store, disk cache, and Telegram mirror are reachable." />
            <EndpointCard method="GET" path="/v1/stats" title="Account statistics" auth="required" description="Returns counts (records / collections / apiKeys / logs / files), activity by day, and recent activity." />
            <EndpointCard method="GET" path="/v1/logs?limit=50&action=…" title="Recent audit log" auth="required" description="Returns the most recent log entries, optionally filtered by action. Each entry: action, key, detail, source, ts." />
          </div>

          {/* Advanced endpoints under /api/v1/* */}
          <div className="space-y-3">
            <h4 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Advanced — <code className="font-mono">/api/v1/*</code>
            </h4>
            <Card className="p-4 bg-card/40 border-border/60">
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                A Supabase-style advanced surface lives under <code className="font-mono text-primary">/api/v1/*</code>{' '}
                (note the <code className="font-mono">/api</code> prefix, distinct from the basic{' '}
                <code className="font-mono">/v1/*</code> surface). All routes require the Bearer API key and are scoped to
                the authenticated user.
              </p>
            </Card>
            <EndpointCard method="GET" path="/api/v1/views" title="List views" auth="required" description="Named projections over a collection (think: SQL VIEW). Create with POST /api/v1/views { name, collection, projection, filter? }." />
            <EndpointCard method="GET" path="/api/v1/views/:name" title="Execute a view" auth="required" description="Applies the stored substring filter on the key and projects the requested columns. Returns the projected rows." />
            <EndpointCard method="GET" path="/api/v1/matviews" title="List materialized views" auth="required" description="Pre-computed aggregations cached as JSON. Create with POST /api/v1/matviews { name, query } — runs the SELECT immediately and caches the result. Refresh-all via POST /api/v1/matviews { action: 'refresh_all' }." />
            <EndpointCard method="GET" path="/api/v1/matviews/:name" title="Read a materialized view" auth="required" description="O(1) read of the cached aggregation result. POST to refresh, DELETE to drop." />
            <EndpointCard method="POST" path="/api/v1/functions" title="Create a server-side function" auth="required" description={`Body: { name, code }. Code runs in a \`new Function("ctx", code)\` sandbox with { record, db, user } — db is read-only and user-scoped. 5s timeout. Syntax-checked at create.`} />
            <EndpointCard method="POST" path="/api/v1/functions/:name" title="Test-invoke a function" auth="required" description="Runs the stored function with the supplied ctx body and returns the result. Useful for prototyping before wiring the function into a view or RPC." />
            <EndpointCard method="POST" path="/api/v1/rpc/:name" title="Built-in RPC" auth="required" description="Built-in remote procedure calls: count_records, sum { key }, aggregate { collection, type: count|sum|avg|min|max }, search { query, collection?, limit? } (substring match on key + value), touch { key, value, collection? } (upsert + return). All user-scoped." />
            <EndpointCard method="POST" path="/api/v1/graphql" title="GraphQL endpoint" auth="required" description="A minimal hand-rolled GraphQL parser (no Apollo/graphql deps). Single endpoint; queries for records, collections, apiKeys, logs, me — all user-scoped via authenticate(). Args + variables supported on records(limit, collection) and logs(limit, action). Standard { data, errors } JSON response." />
          </div>

          {/* Share-token endpoints (recap) */}
          <div className="space-y-3">
            <h4 className="text-[13px] font-semibold uppercase tracking-wider text-muted-foreground/70">Share tokens</h4>
            <EndpointCard method="GET" path="/v1/share/:token" title="Public scoped read" auth="none (token in URL is the credential)" description="Reads the single (collection, key) pair the token is scoped to. Safe to call from any browser, any origin." />
            <EndpointCard method="POST" path="/v1/write/:token" title="Public scoped write" auth="none (token in URL is the credential)" description="Body: { op: 'set'|'incr'|'append', value?, amount? }. Mutates the scoped key. Honors allowedOps, maxValueLength, incrMin/incrMax, and the per-IP rate limit." />
            <EndpointCard method="POST" path="/api/dashboard/share-tokens" title="Create a share token" auth="required" description="Body: { collection?, key, mode: 'read'|'write'|'readwrite', label?, ttlMinutes?, rateLimitPerMin?, allowedOps?, maxValueLength?, incrMin?, incrMax? }. Returns the new token with readUrl + writeUrl." />
            <EndpointCard method="GET" path="/api/dashboard/share-tokens" title="List your share tokens" auth="required" description="Returns every non-revoked share token on your account with usage stats." />
            <EndpointCard method="DELETE" path="/api/dashboard/share-tokens/:id" title="Revoke a share token" auth="required" description="Instant kill switch. The public URL returns 404 on the next request. Cannot be undone." />
          </div>
        </TabsContent>

        {/* ───────────────────────── CLI ───────────────────────── */}
        <TabsContent value="cli" className="space-y-5">
          <Card className="p-5 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-2">
              <Terminal className="size-4 text-primary" />
              <h3 className="font-semibold text-[15px]">The <code className="font-mono">onyx</code> CLI</h3>
            </div>
            <p className="text-[13.5px] text-muted-foreground leading-relaxed">
              A zero-dependency Node.js tool. Install it globally, point it at your server once, and use it from any
              terminal. Config is stored at <code className="font-mono text-primary">~/.onyx/config.json</code> with 0600
              permissions. <code className="font-mono text-primary">get</code> and{' '}
              <code className="font-mono text-primary">list</code> keep stdout clean for piping; type hints go to stderr.
            </p>
          </Card>

          <CodeBlock lang="bash" code={`# Install (zero npm dependencies)
npm i -g onyx-base

# One-time setup: point the CLI at this server
export ONYX_URL=${apiBase}

# Auth
onyx login --name "Ada" --email ada@example.com   # create account → returns kv_live_…
onyx login --key ${keyForCode}                      # connect an existing account
onyx whoami                                         # verify credentials + show user info
onyx logout                                         # clear ~/.onyx/config.json

# Key-value
onyx set greeting "hello world"                     # auto-typed (string)
onyx set coins 500                                  # auto-typed (number)
onyx set premium true                               # auto-typed (boolean)
onyx set user '{"name":"alice","age":30}'           # auto-typed (JSON)
onyx set counter 1 --collection metrics             # write to a non-default collection
onyx get greeting                                   # → "hello world"  (stdout, pipe-friendly)
onyx list                                           # keys only (stdout)
onyx list -v                                        # KEY/TYPE/COLLECTION table (stderr)
onyx delete coins                                   # remove a key
onyx export --output backup.json                    # dump the whole DB as JSON

# Files
onyx upload ./report.pdf --label "Q3 report"        # upload (50 MB cloud / 2 GB local)
onyx files                                          # list stored files
onyx download f_abc123 ./out.pdf                    # download by fileId
onyx file-link f_abc123                             # mint a fresh ~1h download link
onyx file-revoke f_abc123                           # drop the cached link
onyx file-delete f_abc123                           # permanently delete a file`} />

          <Card className="p-4 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-2">
              <Code2 className="size-4 text-primary" />
              <h4 className="font-semibold text-[14px]">Config file</h4>
            </div>
            <p className="text-[13px] text-muted-foreground mb-3">
              Stored at <code className="font-mono text-primary">~/.onyx/config.json</code> with 0600 permissions:
            </p>
            <CodeBlock lang="json" code={`{
  "server": "${apiBase || 'https://onyx.example.com'}",
  "apiKey": "${keyForCode}",
  "userId": "${userId || 'usr_xxxxx'}"
}`} />
          </Card>
        </TabsContent>

        {/* ───────────────────────── Realtime ───────────────────────── */}
        <TabsContent value="realtime" className="space-y-5">
          <Card className="p-5 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-2">
              <Radio className="size-4 text-primary" />
              <h3 className="font-semibold text-[15px]">Socket.io realtime</h3>
            </div>
            <p className="text-[13.5px] text-muted-foreground leading-relaxed">
              The dashboard auto-updates without polling. A Socket.io mini-service (port 3003) fans{' '}
              <code className="font-mono text-primary">record:changed</code> events out to every connected browser
              whenever a key is set, deleted, or mutated via a share token. The Database tab&apos;s row updates in
              place; the Logs tab gets a new entry; the Dashboard stat cards refresh. No refresh button, no
              setInterval, no stale data.
            </p>
          </Card>

          <Card className="p-5 bg-card/40 border-border/60">
            <h4 className="font-semibold text-[14px] mb-2">Connection model</h4>
            <p className="text-[13px] text-muted-foreground leading-relaxed mb-3">
              The browser opens one Socket.io connection to the realtime service (routed through the gateway as{' '}
              <code className="font-mono text-primary">io(&quot;/?XTransformPort=3003&quot;)</code>). The service
              subscribes to per-userId rooms; when an API write happens, the Next.js core emits an event that the
              realtime service broadcasts to everyone in that user&apos;s room. The connection auto-reconnects on drop;
              a small green dot in the sidebar shows live status.
            </p>
            <CodeBlock lang="javascript" code={`// The event payload looks like this:
{
  type: 'record:changed',
  owner: 'usr_xxxxx',
  collection: 'default',
  key: 'coins',
  value: 500,
  previous: 499,
  op: 'set',                  // 'set' | 'delete' | 'incr' | 'append'
  source: 'cli',              // 'dashboard' | 'cli' | 'api' | 'share'
  ts: 1735900000000
}`} />
          </Card>

          <Card className="p-4 bg-primary/5 border-primary/20">
            <div className="flex gap-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0">
                <Zap className="size-4 text-primary" />
              </div>
              <div className="text-sm space-y-1.5">
                <p className="font-medium text-foreground">Why this matters</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  Open the dashboard in two browser tabs, then run <code className="font-mono text-primary">onyx set coins 500</code>{' '}
                  in your terminal. Both tabs update within milliseconds — no polling, no manual refresh. This is what
                  makes the dashboard feel like a live database IDE instead of a static admin panel.
                </p>
              </div>
            </div>
          </Card>
        </TabsContent>

        {/* ───────────────────────── Telegram durability ───────────────────────── */}
        <TabsContent value="telegram" className="space-y-5">
          <Card className="p-5 bg-card/40 border-border/60">
            <div className="flex items-center gap-2.5 mb-2">
              <LifeBuoy className="size-4 text-primary" />
              <h3 className="font-semibold text-[15px]">Telegram IS the durable substrate</h3>
            </div>
            <p className="text-[13.5px] text-foreground/90 leading-relaxed">
              Every mutation — set, delete, api-key create/revoke, collection create/delete, file upload, share token
              create/revoke, signup, login — is mirrored into your private Telegram chat as a structured message. That
              mirror is the durable backup. The in-memory store + JSON-on-disk cache are the fast read path; if they&apos;re
              wiped, the chat still has the full history and the platform can rebuild from it.
            </p>
          </Card>

          <div className="grid sm:grid-cols-2 gap-4">
            <Card className="p-5 bg-card/40 border-border/60">
              <div className="flex items-center gap-2 mb-2">
                <BookOpen className="size-4 text-primary" />
                <h4 className="font-semibold text-[14px]">Mirroring model</h4>
              </div>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                Each KV record is a single message in the chat. Updates <em>edit</em> the message in place (so the chat
                doesn&apos;t grow unboundedly on every write); deletes remove the message. Identity mutations (signup,
                api-key create) update a <strong>pinned manifest message</strong> at the top of the chat — a small JSON
                document that ties your <code className="font-mono">userId</code> to your API key hashes and collection
                list.
              </p>
            </Card>
            <Card className="p-5 bg-card/40 border-border/60">
              <div className="flex items-center gap-2 mb-2">
                <RefreshCw className="size-4 text-primary" />
                <h4 className="font-semibold text-[14px]">Self-healing rehydration</h4>
              </div>
              <p className="text-[13px] text-muted-foreground leading-relaxed">
                If the local store is wiped (disk crash, sandbox reset, accidental delete), the auth layer catches the
                cache-miss on your next request, fetches the pinned manifest from Telegram via{' '}
                <code className="font-mono">getChat</code>, rehydrates your user + API key records into the local store,
                and retries the original request — all transparently. Your <code className="font-mono">kv_live_…</code>{' '}
                key keeps working as if nothing happened.
              </p>
            </Card>
          </div>

          <Card className="p-5 bg-card/40 border-border/60">
            <div className="flex items-center gap-2 mb-2">
              <Server className="size-4 text-primary" />
              <h4 className="font-semibold text-[14px]">Local Bot API server (2 GB files)</h4>
            </div>
            <p className="text-[13px] text-muted-foreground leading-relaxed mb-3">
              Telegram&apos;s cloud Bot API (<code className="font-mono">api.telegram.org</code>) caps uploads at 50 MB
              and <code className="font-mono">getFile</code> downloads at 20 MB. Running your own{' '}
              <a href="https://github.com/tdlib/telegram-bot-api" target="_blank" rel="noreferrer" className="text-primary hover:underline">local Bot API server</a>{' '}
              unlocks the full 2 GB envelope in both directions. Configure it in <strong>Settings → Storage backend →
              Local Bot API server URL</strong> (or via the <code className="font-mono">TELEGRAM_BOT_API_URL</code> env
              var for operator-wide defaults). Each FileRecord remembers which backend holds it, so downloads always
              resolve via the correct server — even if you change config later.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md border border-border/40 bg-muted/20 p-3">
                <div className="text-[11px] font-mono uppercase tracking-wider text-muted-foreground/70 mb-1">Cloud Bot API</div>
                <div className="text-2xl font-semibold tracking-tight">50 MB</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">upload · 20 MB download · default</div>
              </div>
              <div className="rounded-md border border-primary/30 bg-primary/10 p-3">
                <div className="text-[11px] font-mono uppercase tracking-wider text-primary/80 mb-1">Local Bot API</div>
                <div className="text-2xl font-semibold tracking-tight text-primary">2 GB</div>
                <div className="text-[11px] text-muted-foreground mt-0.5">both ways · optional · self-hosted</div>
              </div>
            </div>
          </Card>

          <Card className="p-4 bg-primary/5 border-primary/20">
            <div className="flex gap-3">
              <div className="size-9 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0">
                <Download className="size-4 text-primary" />
              </div>
              <div className="text-sm space-y-1.5">
                <p className="font-medium text-foreground">Why &quot;unlimited & free&quot; is literally true</p>
                <p className="text-muted-foreground text-[13px] leading-relaxed">
                  No storage caps, no API-call quotas, no collection limits, no file-count limits, no &quot;contact sales&quot;
                  wall. The only cost is your own Telegram bot — talk to{' '}
                  <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-primary hover:underline">@BotFather</a>,
                  it&apos;s free, takes 30 seconds, and you already have a Telegram account. Your data lives in{' '}
                  <strong>your</strong> Telegram chat; you can walk away with it at any time. Stop using Onyx Base
                  tomorrow and your full database is still sitting there, fully readable.
                </p>
              </div>
            </div>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

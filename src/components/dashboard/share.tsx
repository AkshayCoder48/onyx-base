'use client'

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Share2,
  Plus,
  Trash2,
  Copy,
  Check,
  Loader2,
  Link2,
  PencilLine,
  ShieldCheck,
  Globe,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useApi, type ShareTokenView } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from '@/components/ui/dialog'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { PageHeader } from './shell'
import { timeAgo } from './shared'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

const MODE_LABEL: Record<ShareTokenView['mode'], string> = {
  read: 'Read-only',
  write: 'Write-only',
  readwrite: 'Read + Write',
}

const MODE_STYLE: Record<ShareTokenView['mode'], string> = {
  read: 'border-sky-300 bg-sky-100 text-sky-800',
  write: 'border-amber-300 bg-amber-100 text-amber-800',
  readwrite: 'border-primary/30 bg-primary/10 text-primary',
}

export function ShareView() {
  const api = useApi()
  const qc = useQueryClient()

  const [createOpen, setCreateOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<ShareTokenView | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [copiedId, setCopiedId] = useState<string | null>(null)

  // Create-form state
  const [fKey, setFKey] = useState('')
  const [fCollection, setFCollection] = useState('default')
  const [fMode, setFMode] = useState<ShareTokenView['mode']>('read')
  const [fLabel, setFLabel] = useState('')
  const [fTtl, setFTtl] = useState('')
  const [fLimit, setFLimit] = useState('30')
  const [fOps, setFOps] = useState<{ set: boolean; incr: boolean; append: boolean }>({
    set: true,
    incr: true,
    append: false,
  })
  const [fMaxLen, setFMaxLen] = useState('4096')
  const [fIncrMin, setFIncrMin] = useState('')
  const [fIncrMax, setFIncrMax] = useState('')
  const [creating, setCreating] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['share-tokens'],
    queryFn: () => api<{ shareTokens: ShareTokenView[] }>('/api/dashboard/share-tokens'),
  })
  const tokens = (data?.shareTokens ?? []).filter((t) => !t.revoked)

  function resetForm() {
    setFKey('')
    setFCollection('default')
    setFMode('read')
    setFLabel('')
    setFTtl('')
    setFLimit('30')
    setFOps({ set: true, incr: true, append: false })
    setFMaxLen('4096')
    setFIncrMin('')
    setFIncrMax('')
  }

  async function create() {
    if (!fKey.trim()) {
      toast.error('Key is required')
      return
    }
    setCreating(true)
    try {
      const allowedOps = (
        ['set', 'incr', 'append'] as const
      ).filter((o) => fOps[o])
      const body: Record<string, unknown> = {
        key: fKey.trim(),
        collection: fCollection.trim() || 'default',
        mode: fMode,
        label: fLabel.trim() || undefined,
        rateLimitPerMin: fLimit.trim() ? Number(fLimit) : null,
        ttlMinutes: fTtl.trim() ? Number(fTtl) : null,
      }
      if (fMode !== 'read') {
        body.allowedOps = allowedOps
        body.maxValueLength = fMaxLen.trim() ? Number(fMaxLen) : null
        if (fIncrMin.trim()) body.incrMin = Number(fIncrMin)
        if (fIncrMax.trim()) body.incrMax = Number(fIncrMax)
      }
      await api('/api/dashboard/share-tokens', {
        method: 'POST',
        body: JSON.stringify(body),
      })
      toast.success('Share token created')
      resetForm()
      setCreateOpen(false)
      qc.invalidateQueries({ queryKey: ['share-tokens'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  async function copy(text: string, id: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      toast.success('Copied to clipboard')
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      toast.error('Copy failed — select and copy manually')
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await api(`/api/dashboard/share-tokens/${deleteTarget.id}`, { method: 'DELETE' })
      toast.success('Share token revoked')
      setDeleteTarget(null)
      qc.invalidateQueries({ queryKey: ['share-tokens'] })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Revoke failed')
    } finally {
      setDeleting(false)
    }
  }

  const isWrite = fMode !== 'read'

  return (
    <div>
      <PageHeader
        title="Public Share Tokens"
        description="Scoped, revocable tokens that are safe to embed in public HTML (CodePen, static sites, browser extensions)."
        actions={
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Plus className="size-4" /> New share token
          </Button>
        }
      />

      {/* Explanation banner */}
      <Card className="p-4 mb-5 bg-primary/5 border-primary/20">
        <div className="flex gap-3">
          <div className="size-9 rounded-lg bg-primary/10 border border-primary/30 grid place-items-center shrink-0">
            <ShieldCheck className="size-4 text-primary" />
          </div>
          <div className="text-sm space-y-1.5">
            <p className="font-medium text-foreground">Never paste your master API key into public HTML</p>
            <p className="text-muted-foreground text-[13px] leading-relaxed">
              Platforms that show your full source code to everyone (e.g. public code editors, static site hosts) expose anything you paste.
              A share token is scoped to <strong>one key only</strong>, can be <strong>read-only</strong> or <strong>write-only</strong>,
              has a per-IP <strong>rate limit</strong> and optional <strong>expiry</strong>, and can be <strong>revoked instantly</strong>.
              If it leaks, the worst case is one value gets exposed — you revoke and rotate.
            </p>
          </div>
        </div>
      </Card>

      {isLoading ? (
        <div className="py-16 grid place-items-center">
          <Loader2 className="size-5 animate-spin text-primary" />
        </div>
      ) : tokens.length === 0 ? (
        <Card className="bg-card/40 border-border/60 py-16 text-center">
          <Share2 className="size-8 text-muted-foreground/40 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">No share tokens yet.</p>
          <p className="text-xs text-muted-foreground/70 mt-1">
            Create one to expose a single key to public HTML safely.
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {tokens.map((t) => (
            <Card key={t.id} className="p-4 bg-card/40 border-border/60 hover:border-primary/30 transition-colors">
              <div className="flex flex-col sm:flex-row sm:items-start gap-3">
                <div className="size-9 rounded-lg bg-primary/10 border border-primary/20 grid place-items-center shrink-0">
                  <Link2 className="size-4 text-primary" />
                </div>
                <div className="flex-1 min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium truncate">{t.key}</span>
                    <Badge variant="outline" className={cn('text-[10px] uppercase px-1.5 py-0', MODE_STYLE[t.mode])}>
                      {MODE_LABEL[t.mode]}
                    </Badge>
                    <span className="text-[11px] text-muted-foreground/70 font-mono">
                      {t.collection}/{t.key}
                    </span>
                  </div>
                  {t.label && (
                    <div className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <PencilLine className="size-3" /> {t.label}
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
                    {t.rateLimitPerMin && <span>{t.rateLimitPerMin} req/min per IP</span>}
                    {t.expiresAt && <span>expires {timeAgo(t.expiresAt)}</span>}
                    {isWriteMode(t) && (
                      <span>ops: {t.allowedOps.join(', ')}</span>
                    )}
                    {t.maxValueLength && isWriteMode(t) && <span>max {t.maxValueLength}B</span>}
                    {t.lastUsedAt ? <span>last used {timeAgo(t.lastUsedAt)}</span> : <span>never used</span>}
                    <span>created {timeAgo(t.createdAt)}</span>
                  </div>
                  {/* URL copy rows */}
                  <div className="mt-2 space-y-1.5">
                    {(t.mode === 'read' || t.mode === 'readwrite') && (
                      <UrlRow
                        icon={<Eye className="size-3" />}
                        label="GET"
                        url={t.readUrl}
                        copied={copiedId === t.id + '-r'}
                        onCopy={() => copy(t.readUrl, t.id + '-r')}
                      />
                    )}
                    {(t.mode === 'write' || t.mode === 'readwrite') && (
                      <UrlRow
                        icon={<PencilLine className="size-3" />}
                        label="POST"
                        url={t.writeUrl}
                        copied={copiedId === t.id + '-w'}
                        onCopy={() => copy(t.writeUrl, t.id + '-w')}
                      />
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0 hover:text-red-600"
                  onClick={() => setDeleteTarget(t)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ── Create dialog ── */}
      <Dialog open={createOpen} onOpenChange={(v) => { setCreateOpen(v); if (!v) resetForm() }}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto scroll-slim">
          <DialogHeader>
            <DialogTitle>New share token</DialogTitle>
            <DialogDescription>
              Expose one key to public HTML without leaking your master API key.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            {/* Key + collection */}
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="st-key" className="text-xs">Key</Label>
                <Input
                  id="st-key"
                  value={fKey}
                  onChange={(e) => setFKey(e.target.value)}
                  placeholder="leaderboard"
                  className="font-mono text-sm h-9"
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="st-col" className="text-xs">Collection</Label>
                <Input
                  id="st-col"
                  value={fCollection}
                  onChange={(e) => setFCollection(e.target.value)}
                  placeholder="default"
                  className="font-mono text-sm h-9"
                />
              </div>
            </div>

            {/* Mode */}
            <div className="space-y-1.5">
              <Label className="text-xs">Mode</Label>
              <div className="grid grid-cols-3 gap-2">
                {(['read', 'write', 'readwrite'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setFMode(m)}
                    className={cn(
                      'h-9 rounded-md border text-xs font-medium transition-colors',
                      fMode === m
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50',
                    )}
                  >
                    {MODE_LABEL[m]}
                  </button>
                ))}
              </div>
            </div>

            {/* Label */}
            <div className="space-y-1.5">
              <Label htmlFor="st-label" className="text-xs">Label (optional)</Label>
              <Input
                id="st-label"
                value={fLabel}
                onChange={(e) => setFLabel(e.target.value)}
                placeholder="Public leaderboard counter"
                className="text-sm h-9"
              />
            </div>

            {/* TTL + rate limit */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="st-ttl" className="text-xs">TTL (minutes, 0=never)</Label>
                <Input
                  id="st-ttl"
                  value={fTtl}
                  onChange={(e) => setFTtl(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="0"
                  className="font-mono text-sm h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="st-limit" className="text-xs">Rate limit (req/min/IP, 0=∞)</Label>
                <Input
                  id="st-limit"
                  value={fLimit}
                  onChange={(e) => setFLimit(e.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="30"
                  className="font-mono text-sm h-9"
                />
              </div>
            </div>

            {/* Write-specific options */}
            {isWrite && (
              <div className="space-y-3 p-3 rounded-md border border-border/60 bg-muted/30">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
                  Write options
                </div>
                {/* Allowed ops */}
                <div className="space-y-1.5">
                  <Label className="text-xs">Allowed operations</Label>
                  <div className="flex flex-wrap gap-2">
                    {(['set', 'incr', 'append'] as const).map((o) => (
                      <button
                        key={o}
                        type="button"
                        onClick={() => setFOps((p) => ({ ...p, [o]: !p[o] }))}
                        className={cn(
                          'h-8 px-3 rounded-md border text-xs font-mono transition-colors',
                          fOps[o]
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border/60 text-muted-foreground hover:bg-muted/50',
                        )}
                      >
                        {fOps[o] && <Check className="size-3 inline mr-1" />}
                        {o}
                      </button>
                    ))}
                  </div>
                </div>
                {/* Max value length */}
                <div className="space-y-1.5">
                  <Label htmlFor="st-maxlen" className="text-xs">Max value length (bytes, 0=∞)</Label>
                  <Input
                    id="st-maxlen"
                    value={fMaxLen}
                    onChange={(e) => setFMaxLen(e.target.value.replace(/[^0-9]/g, ''))}
                    placeholder="4096"
                    className="font-mono text-sm h-9"
                  />
                </div>
                {/* Incr bounds */}
                {fOps.incr && (
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="st-imin" className="text-xs">Incr min (optional)</Label>
                      <Input
                        id="st-imin"
                        value={fIncrMin}
                        onChange={(e) => setFIncrMin(e.target.value.replace(/[^0-9-]/g, ''))}
                        placeholder="0"
                        className="font-mono text-sm h-9"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="st-imax" className="text-xs">Incr max (optional)</Label>
                      <Input
                        id="st-imax"
                        value={fIncrMax}
                        onChange={(e) => setFIncrMax(e.target.value.replace(/[^0-9]/g, ''))}
                        placeholder="1000000"
                        className="font-mono text-sm h-9"
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Live preview */}
            <div className="p-3 rounded-md border border-primary/20 bg-primary/5">
              <div className="text-[11px] font-medium uppercase tracking-wider text-primary/80 mb-1.5 flex items-center gap-1.5">
                <Globe className="size-3" /> What goes in your HTML
              </div>
              <code className="block text-[11px] font-mono text-foreground/80 break-all">
                {fMode === 'read' || fMode === 'readwrite' ? (
                  <>fetch(&apos;https://your-app/v1/share/<span className="text-primary">st_…</span>&apos;)</>
                ) : (
                  <>fetch(&apos;https://your-app/v1/write/<span className="text-primary">st_…</span>&apos;, &#123;method:&apos;POST&apos;, body:&#123;op:&apos;incr&apos;, amount:1&#125;&#125;)</>
                )}
              </code>
              <p className="text-[11px] text-muted-foreground/70 mt-1.5">
                No API key. No bot token. Just the scoped token — safe to leak.
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={create}
              disabled={creating || !fKey.trim()}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {creating ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} Create token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Revoke confirm ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this share token?</AlertDialogTitle>
            <AlertDialogDescription>
              The public URL <span className="font-mono">{deleteTarget?.token.slice(0, 16)}…</span> will stop working
              immediately. Any HTML still using it will get a 404. This cannot be undone — you&apos;d create a new token
              and update your HTML.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              disabled={deleting}
              className="bg-red-500 hover:bg-red-600 text-white"
            >
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null} Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function isWriteMode(t: ShareTokenView) {
  return t.mode === 'write' || t.mode === 'readwrite'
}

function UrlRow({
  icon,
  label,
  url,
  copied,
  onCopy,
}: {
  icon: React.ReactNode
  label: string
  url: string
  copied: boolean
  onCopy: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-2 py-1.5">
      <span className="text-[10px] font-mono font-semibold uppercase text-muted-foreground/70 w-10 shrink-0 flex items-center gap-1">
        {icon}{label}
      </span>
      <code className="flex-1 min-w-0 text-[11px] font-mono text-foreground/70 truncate">{url}</code>
      <Button
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 hover:text-primary"
        onClick={onCopy}
      >
        {copied ? <Check className="size-3 text-primary" /> : <Copy className="size-3" />}
      </Button>
    </div>
  )
}

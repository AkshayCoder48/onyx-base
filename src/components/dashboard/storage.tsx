'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  HardDrive,
  Upload,
  Copy,
  Check,
  Download,
  Trash2,
  FileIcon,
  FileText,
  FileImage,
  FileArchive,
  FileVideo,
  FileAudio,
  FileCode,
  File as FileGeneric,
  ExternalLink,
  Loader2,
  AlertCircle,
  Lock,
  Unlock,
  Server,
  Info,
  RefreshCw,
  Clock,
  Link2,
  Timer,
} from 'lucide-react'
import { useApi, type FileView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PageHeader } from './shell'
import { formatBytes, timeAgo } from './shared'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/** Pick an icon based on the file's MIME type / extension. */
function iconForFile(name: string, mime: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext))
    return FileImage
  if (mime.startsWith('video/') || ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv'].includes(ext))
    return FileVideo
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext))
    return FileAudio
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext))
    return FileArchive
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'cs', 'php', 'sh', 'html', 'css', 'json', 'xml', 'yaml', 'yml'].includes(ext))
    return FileCode
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'rtf'].includes(ext) || mime.startsWith('text/'))
    return FileText
  return FileIcon
}

const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024 // 2 GB — enforced app-side (Telegram's hard ceiling)

// ─── On-demand download link state ───────────────────────────────────────────
//
// Telegram revokes `getFile` download URLs after ~1 hour. So instead of
// handing out a permanent link that proxies every download through Telegram
// (which would spam the Telegram API), we use an explicit "Get link" button:
//
//   1. User taps "Get link" → we POST /api/files/[id]/link.
//   2. Backend calls Telegram's getFile ONCE (cached for 55 min server-side)
//      and mints an HMAC-signed URL on our origin valid for ~1 hour.
//   3. The dialog shows the URL + a live countdown + Copy / Open / Refresh.
//   4. After the link expires, the user taps "Refresh" to pull a brand-new
//      URL from Telegram. No auto-refresh — that would spam Telegram.
//
// This state machine tracks one active link dialog at a time.

type LinkState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
      status: 'ready'
      /** The raw Telegram cloud download URL (api.telegram.org/file/bot…). */
      url: string
      /** The proxied URL on our origin — permanent for public files. */
      proxyUrl: string
      expiresAt: number
      fileName: string
      isPublic: boolean
      revocable: boolean
    }
  | { status: 'revoking' }
  | { status: 'revoked'; fileName: string; isPublic: boolean }
  | { status: 'error'; message: string }

/** Format a remaining-seconds count as `M:SS` (or `H:MM:SS` for >1h, which shouldn't happen). */
function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'expired'
  const h = Math.floor(secondsLeft / 3600)
  const m = Math.floor((secondsLeft % 3600) / 60)
  const s = secondsLeft % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

export function CloudStorageView() {
  const api = useApi()
  const apiKey = useOnyxBase((s) => s.apiKey)
  const qc = useQueryClient()

  const [uploadOpen, setUploadOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [label, setLabel] = useState('')
  const [isPublic, setIsPublic] = useState(true)
  const [dragOver, setDragOver] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<FileView | null>(null)
  // Which file is currently fetching a Telegram URL for the quick-copy button.
  const [copyingId, setCopyingId] = useState<string | null>(null)
  // Which file's Telegram URL was just copied (shows a green check for 1.5s).
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ─── On-demand link dialog state ──────────────────────────────────────────
  const [linkTarget, setLinkTarget] = useState<FileView | null>(null)
  const [linkState, setLinkState] = useState<LinkState>({ status: 'idle' })
  const [linkCopied, setLinkCopied] = useState(false)
  const [secondsLeft, setSecondsLeft] = useState(0)

  const { data, isLoading } = useQuery({
    queryKey: ['files'],
    queryFn: () => api<{ files: FileView[]; maxFileSize: number }>('/api/files'),
  })

  const uploadMutation = useMutation({
    mutationFn: async (opts: { file: File; label: string; isPublic: boolean }) => {
      // Bypass the JSON api() helper — this is a multipart upload.
      const form = new FormData()
      form.append('file', opts.file)
      if (opts.label.trim()) form.append('label', opts.label.trim())
      form.append('public', opts.isPublic ? 'true' : 'false')
      const res = await fetch('/api/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json?.error || `Upload failed (${res.status})`)
      return json as { file: FileView }
    },
    onSuccess: () => {
      toast.success('File uploaded — tap "Get link" to mint a download URL')
      qc.invalidateQueries({ queryKey: ['files'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      resetUpload()
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api<{ deleted: boolean }>(`/api/files/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('File deleted')
      qc.invalidateQueries({ queryKey: ['files'] })
      qc.invalidateQueries({ queryKey: ['stats'] })
      setDeleteTarget(null)
    },
    onError: (err: Error) => toast.error(err.message),
  })

  /**
   * Fetch a fresh download link from the backend. Called when the user
   * taps "Get link" (force=false → uses the server's 55-min cache, so usually
   * ZERO Telegram API calls) or "Refresh" (force=true → busts the cache and
   * pulls a brand-new URL from Telegram).
   *
   * The returned `url` is the RAW Telegram cloud link
   * (api.telegram.org/file/bot…/…). Telegram revokes it after ~1 hour.
   *
   * This is the ONLY place that triggers a Telegram getFile call from the UI,
   * and it only runs on an explicit user tap — never automatically — to avoid
   * spamming the Telegram servers.
   */
  const fetchLink = useCallback(
    async (file: FileView, force: boolean) => {
      setLinkState({ status: 'loading' })
      setLinkCopied(false)
      try {
        const path = `/api/files/${file.id}/link${force ? '?force=1' : ''}`
        const res = await api<{
          url: string
          proxyUrl: string
          expiresAt: number
          expiresInSec: number
          revocable: boolean
          file: { fileName: string; isPublic: boolean }
        }>(path, { method: 'POST' })
        setLinkState({
          status: 'ready',
          url: res.url,
          proxyUrl: res.proxyUrl,
          expiresAt: res.expiresAt,
          fileName: res.file.fileName,
          isPublic: res.file.isPublic,
          revocable: res.revocable,
        })
        setSecondsLeft(Math.max(0, res.expiresInSec))
      } catch (err) {
        setLinkState({ status: 'error', message: err instanceof Error ? err.message : 'Could not fetch a link from Telegram.' })
      }
    },
    [api],
  )

  /**
   * Revoke the current Telegram download link. Drops the server-side cache
   * and marks the file's link as revoked. The next "Get link" call will mint
   * a brand-new URL from Telegram.
   *
   * NOTE: Telegram's own getFile URL remains valid until its natural ~1-hour
   * expiry — we cannot force Telegram to revoke it sooner. But after /revoke,
   * we no longer cache or re-serve it on our side.
   */
  const revokeLink = useCallback(
    async (file: FileView) => {
      setLinkState({ status: 'revoking' })
      try {
        await api<{ revoked: boolean; note: string }>(`/api/files/${file.id}/revoke`, { method: 'POST' })
        setLinkState({ status: 'revoked', fileName: file.fileName, isPublic: file.isPublic })
        setSecondsLeft(0)
        toast.success('Link revoked — cached URL dropped. Tap "Get link" to mint a new one.')
        qc.invalidateQueries({ queryKey: ['files'] })
      } catch (err) {
        setLinkState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not revoke the link.',
        })
      }
    },
    [api, qc],
  )

  const openLinkDialog = useCallback(
    (file: FileView) => {
      setLinkTarget(file)
      void fetchLink(file, false)
    },
    [fetchLink],
  )

  const closeLinkDialog = useCallback(() => {
    setLinkTarget(null)
    setLinkState({ status: 'idle' })
    setLinkCopied(false)
    setSecondsLeft(0)
  }, [])

  // ─── Live countdown ticker ────────────────────────────────────────────────
  // Updates the "valid for MM:SS" label every second while a link is ready.
  // When it hits zero, we flip the state so the UI prompts the user to refresh.
  useEffect(() => {
    if (linkState.status !== 'ready') return
    const tick = () => {
      const remaining = Math.max(0, Math.floor((linkState.expiresAt - Date.now()) / 1000))
      setSecondsLeft(remaining)
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [linkState])

  const copySignedLink = useCallback(async () => {
    if (linkState.status !== 'ready') return
    try {
      await navigator.clipboard.writeText(linkState.url)
      setLinkCopied(true)
      toast.success('Download link copied — valid for ~1 hour')
      setTimeout(() => setLinkCopied(false), 1800)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }, [linkState])

  const onFilesPicked = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    const f = files[0]
    if (f.size > MAX_FILE_SIZE) {
      toast.error(`File is ${(f.size / 1024 / 1024).toFixed(1)} MB — the 2 GB per-file limit was exceeded.`)
      return
    }
    setSelectedFile(f)
    setUploadOpen(true)
  }, [])

  const resetUpload = () => {
    setSelectedFile(null)
    setLabel('')
    setIsPublic(true)
    setUploadOpen(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  /**
   * Quick-copy button on each file row: fetches the Telegram DIRECT URL
   * (api.telegram.org/file/bot…/…) from /api/files/[id]/link and copies it to
   * the clipboard. This is NOT the proxy URL — it's the real Telegram cloud
   * link, valid ~1 hour, fetched on-demand only when the user taps the button.
   */
  const copyTelegramLink = async (file: FileView) => {
    if (copyingId) return
    setCopyingId(file.id)
    try {
      const res = await api<{ url: string; expiresAt: number }>(
        `/api/files/${file.id}/link`,
        { method: 'POST' },
      )
      await navigator.clipboard.writeText(res.url)
      setCopiedId(file.id)
      toast.success('Telegram link copied (valid ~1 hour)')
      setTimeout(() => setCopiedId(null), 1500)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not fetch Telegram link')
    } finally {
      setCopyingId(null)
    }
  }

  const totalBytes = data?.files.reduce((sum, f) => sum + f.size, 0) ?? 0

  return (
    <div>
      <PageHeader
        title="Cloud Storage"
        description="Store files up to 2 GB each — any extension, unlimited count. Tap “Get link” to mint a 1-hour download URL from Telegram."
        actions={
          <Button
            onClick={() => fileInputRef.current?.click()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            <Upload className="size-4" /> Upload file
          </Button>
        }
      />

      {/* Storage-routing + on-demand link banner. */}
      <div className="mb-6 flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3.5 text-xs">
        <Info className="size-4 shrink-0 mt-0.5 text-primary" />
        <div className="space-y-1 text-foreground/80">
          <p className="font-medium text-foreground/90">Telegram-backed storage · links refresh on demand</p>
          <p>
            Files live in a Telegram chat (the operator’s server-side bot by default, or your own custom bot
            from Settings). Telegram revokes file URLs after <strong>1 hour</strong>, so each file has a{' '}
            <strong>“Get link”</strong> button — tap it to mint a fresh download URL. The link stops working
            after an hour; tap <strong>Refresh</strong> to pull a new one from Telegram. Links are only
            fetched on your tap, never automatically, to avoid spamming Telegram.
          </p>
        </div>
      </div>

      {/* Hidden native file input — accepts everything. */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => onFilesPicked(e.target.files)}
      />

      {/* Stats strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
        <Card className="p-4 bg-card/40 border-border/60">
          <div className="text-xs text-muted-foreground mb-1">Files</div>
          <div className="text-2xl font-semibold tabular-nums">{data?.files.length ?? '—'}</div>
        </Card>
        <Card className="p-4 bg-card/40 border-border/60">
          <div className="text-xs text-muted-foreground mb-1">Total size</div>
          <div className="text-2xl font-semibold tabular-nums">{formatBytes(totalBytes)}</div>
        </Card>
        <Card className="p-4 bg-card/40 border-border/60">
          <div className="text-xs text-muted-foreground mb-1">Per-file limit</div>
          <div className="text-2xl font-semibold tabular-nums">2 GB</div>
        </Card>
      </div>

      {/* Drag & drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          onFilesPicked(e.dataTransfer.files)
        }}
        onClick={() => fileInputRef.current?.click()}
        className={cn(
          'mb-6 rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors',
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border/60 hover:border-primary/40 hover:bg-muted/30',
        )}
      >
        <HardDrive className="size-7 mx-auto mb-2 text-muted-foreground" />
        <p className="text-sm font-medium">Drop a file here or click to browse</p>
        <p className="text-xs text-muted-foreground mt-1">
          Any file type — exe, txt, png, jpg, zip, video, audio, anything. Up to 2 GB each.
        </p>
      </div>

      {/* File list */}
      {isLoading ? (
        <Card className="p-10 bg-card/40 border-border/60 text-center text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin mx-auto mb-2" /> Loading files…
        </Card>
      ) : data && data.files.length > 0 ? (
        <Card className="bg-card/40 border-border/60 divide-y divide-border/40 overflow-hidden">
          {data.files.map((f) => {
            const Icon = iconForFile(f.fileName, f.mimeType)
            return (
              <div key={f.id} className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
                <div className="size-9 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                  <Icon className="size-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm truncate text-foreground/90">{f.fileName}</span>
                    {f.isPublic ? (
                      <Unlock className="size-3 text-muted-foreground shrink-0" />
                    ) : (
                      <Lock className="size-3 text-muted-foreground shrink-0" />
                    )}
                    {f.storageMode === 'custom' ? (
                      <Badge variant="outline" className="font-mono text-[9px] px-1 py-0 shrink-0" title="Stored on your own custom Telegram bot">
                        custom
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="font-mono text-[9px] px-1 py-0 shrink-0 gap-0.5" title="Stored on the operator's server-side Telegram bot">
                        <Server className="size-2.5" /> server
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="tabular-nums">{formatBytes(f.size)}</span>
                    <span>·</span>
                    <span className="truncate">{f.mimeType || 'unknown'}</span>
                    <span>·</span>
                    <span>{timeAgo(f.createdAt)}</span>
                    <span>·</span>
                    <span className="tabular-nums">{f.downloads} dl</span>
                    {f.label && (
                      <>
                        <span>·</span>
                        <Badge variant="outline" className="font-mono text-[9px] px-1 py-0">{f.label}</Badge>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {/* Copy Telegram link — fetches the raw Telegram cloud URL
                      on tap and copies it to the clipboard. NOT a proxy link. */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyTelegramLink(f)}
                    disabled={!!copyingId}
                    className="h-8 px-2"
                    title="Fetch & copy Telegram download link (valid ~1 hour)"
                  >
                    {copyingId === f.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : copiedId === f.id ? (
                      <Check className="size-3.5 text-green-600" />
                    ) : (
                      <Link2 className="size-3.5" />
                    )}
                  </Button>
                  {/* Get link — the primary download action. Mints a fresh,
                      1-hour signed URL from Telegram on tap (no auto-refresh). */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openLinkDialog(f)}
                    className="h-8 px-2 text-primary hover:text-primary"
                    title="Get download link (valid 1 hour)"
                  >
                    <Download className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(f)}
                    className="h-8 px-2 text-muted-foreground hover:text-red-600"
                    title="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </Card>
      ) : (
        <Card className="p-10 bg-card/40 border-border/60 text-center">
          <FileGeneric className="size-8 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm font-medium">No files stored yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            Upload your first file — it’ll be mirrored to your Telegram chat. Tap “Get link” to share it.
          </p>
        </Card>
      )}

      {/* Upload dialog (file picked, confirm metadata) */}
      <Dialog open={uploadOpen} onOpenChange={(o) => { if (!o) resetUpload() }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload file</DialogTitle>
            <DialogDescription>
              The file is streamed to your Telegram chat and indexed. Tap “Get link” afterwards to mint a download URL.
            </DialogDescription>
          </DialogHeader>
          {selectedFile && (
            <div className="space-y-4">
              <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = iconForFile(selectedFile.name, selectedFile.type)
                    return <Icon className="size-4 text-primary" />
                  })()}
                  <span className="font-mono text-sm truncate">{selectedFile.name}</span>
                </div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {formatBytes(selectedFile.size)} · {selectedFile.type || 'unknown type'}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="file-label">Label (optional)</Label>
                <Input
                  id="file-label"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. Q3 report"
                />
              </div>

              <div className="flex items-center justify-between rounded-md border border-border/60 p-3">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Public file</div>
                  <div className="text-xs text-muted-foreground">
                    If on, anyone with a minted link can download. If off, only you can mint links from the dashboard.
                  </div>
                </div>
                <Switch checked={isPublic} onCheckedChange={setIsPublic} />
              </div>

              {selectedFile.size > 50 * 1024 * 1024 && (
                <div className="flex items-start gap-2 rounded-md border border-amber-300/40 bg-amber-50 p-3 text-xs text-amber-800">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <div>
                    Files over 50 MB require a self-hosted <a className="underline" href="https://github.com/tdlib/telegram-bot-api" target="_blank" rel="noreferrer">local Telegram Bot API server</a> for upload, and over 20 MB for download via <code className="font-mono">getFile</code>. The 2 GB ceiling is enforced app-side either way.
                  </div>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={resetUpload}>Cancel</Button>
            <Button
              onClick={() => selectedFile && uploadMutation.mutate({ file: selectedFile, label, isPublic })}
              disabled={uploadMutation.isPending || !selectedFile}
            >
              {uploadMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Get-link dialog ───────────────────────────────────────────────────
          Shows the fresh signed URL, a live countdown to expiry, and
          Copy / Open / Refresh actions. Refresh busts the server cache and
          pulls a brand-new URL from Telegram (only on explicit tap). */}
      <Dialog open={!!linkTarget} onOpenChange={(o) => { if (!o) closeLinkDialog() }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Download className="size-4 text-primary" />
              Telegram download link
            </DialogTitle>
            <DialogDescription>
              Fetched straight from Telegram's <code className="font-mono">getFile</code> API. Telegram revokes the URL after ~1 hour — tap Refresh or Get link again after that.
            </DialogDescription>
          </DialogHeader>

          {linkTarget && (
            <div className="space-y-4">
              {/* File summary */}
              <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1">
                <div className="flex items-center gap-2">
                  {(() => {
                    const Icon = iconForFile(linkTarget.fileName, linkTarget.mimeType)
                    return <Icon className="size-4 text-primary" />
                  })()}
                  <span className="font-mono text-sm truncate">{linkTarget.fileName}</span>
                  {linkTarget.isPublic ? (
                    <Unlock className="size-3 text-muted-foreground shrink-0" />
                  ) : (
                    <Lock className="size-3 text-muted-foreground shrink-0" />
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground font-mono">
                  {formatBytes(linkTarget.size)} · {linkTarget.mimeType || 'unknown'} · {linkTarget.storageMode} bot
                  {linkTarget.linkRevokedAt && (
                    <span className="text-amber-700"> · link revoked {new Date(linkTarget.linkRevokedAt).toLocaleTimeString()}</span>
                  )}
                </div>
              </div>

              {/* State machine: loading / ready / revoking / revoked / error */}
              {linkState.status === 'loading' && (
                <div className="flex items-center gap-2 rounded-md border border-border/60 p-4 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin text-primary" />
                  Asking Telegram for a fresh download URL…
                </div>
              )}

              {linkState.status === 'revoking' && (
                <div className="flex items-center gap-2 rounded-md border border-amber-300/50 bg-amber-50 p-4 text-sm text-amber-800">
                  <Loader2 className="size-4 animate-spin" />
                  Revoking the cached link…
                </div>
              )}

              {linkState.status === 'revoked' && (
                <div className="space-y-3">
                  <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-800">
                    <AlertCircle className="size-4 shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <p>The cached Telegram URL has been dropped from our server.</p>
                      <p className="text-amber-700">
                        Note: Telegram's own URL remains valid until its natural ~1-hour expiry — we can't force
                        Telegram to revoke it sooner. But we no longer cache or re-serve it.
                      </p>
                    </div>
                  </div>
                  <Button
                    className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
                    size="sm"
                    onClick={() => linkTarget && fetchLink(linkTarget, true)}
                  >
                    <Download className="size-3.5 mr-1.5" /> Get a new link from Telegram
                  </Button>
                </div>
              )}

              {linkState.status === 'error' && (
                <div className="flex items-start gap-2 rounded-md border border-red-300/50 bg-red-50 p-3 text-xs text-red-700">
                  <AlertCircle className="size-4 shrink-0 mt-0.5" />
                  <div className="space-y-2">
                    <p>{linkState.message}</p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => linkTarget && fetchLink(linkTarget, true)}
                      className="h-7 text-xs"
                    >
                      <RefreshCw className="size-3 mr-1" /> Try again (force refresh)
                    </Button>
                  </div>
                </div>
              )}

              {linkState.status === 'ready' && (
                <div className="space-y-3">
                  {/* The Telegram direct URL — read-only, with a copy button. */}
                  <div className="space-y-1.5">
                    <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                      <Link2 className="size-3" /> Telegram cloud URL
                    </Label>
                    <div className="flex gap-2">
                      <Input
                        readOnly
                        value={linkState.url}
                        className="font-mono text-xs h-9"
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={copySignedLink}
                        className="h-9 px-3 shrink-0"
                        title="Copy link"
                      >
                        {linkCopied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
                      </Button>
                    </div>
                  </div>

                  {/* Countdown + expiry notice */}
                  <div
                    className={cn(
                      'flex items-center gap-2 rounded-md border p-2.5 text-xs',
                      secondsLeft > 0
                        ? 'border-primary/30 bg-primary/5 text-foreground/80'
                        : 'border-red-300/50 bg-red-50 text-red-700',
                    )}
                  >
                    {secondsLeft > 0 ? (
                      <>
                        <Timer className="size-3.5 text-primary" />
                        <span>
                          Valid for <strong className="tabular-nums">{formatCountdown(secondsLeft)}</strong>
                        </span>
                        <span className="text-muted-foreground">· then tap Refresh for a new one</span>
                      </>
                    ) : (
                      <>
                        <Clock className="size-3.5" />
                        <span>This link has expired. Tap Refresh to pull a new one from Telegram.</span>
                      </>
                    )}
                  </div>

                  {/* Action row: Download · Open · Refresh · Revoke */}
                  <div className="flex flex-wrap gap-2">
                    <a href={linkState.url} target="_blank" rel="noreferrer" className="flex-1 min-w-[120px]">
                      <Button className="w-full bg-primary hover:bg-primary/90 text-primary-foreground" size="sm">
                        <Download className="size-3.5 mr-1.5" /> Download
                      </Button>
                    </a>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => linkTarget && fetchLink(linkTarget, true)}
                      className="h-9"
                      title="Bust the cache and pull a brand-new URL from Telegram"
                    >
                      <RefreshCw className="size-3.5 mr-1.5" /> Refresh
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => linkTarget && revokeLink(linkTarget)}
                      className="h-9 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                      title="Drop the cached URL from our server. Telegram's own URL remains valid until its natural ~1h expiry."
                    >
                      <Trash2 className="size-3.5 mr-1.5" /> Revoke
                    </Button>
                  </div>

                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    <Info className="inline size-3 mr-1 align-text-bottom" />
                    This is Telegram's raw cloud link (<code className="font-mono">api.telegram.org/file/…</code>),
                    fetched on-demand and cached ~55 min so we don't spam Telegram. Revoke drops our cache — the next
                    Get link call mints a brand-new URL.
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={closeLinkDialog}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this file?</AlertDialogTitle>
            <AlertDialogDescription>
              <code className="font-mono">{deleteTarget?.fileName}</code> will be permanently removed from Telegram and any download links will stop working. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleteMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const TYPE_STYLES: Record<string, string> = {
  string: 'border-primary/30 bg-primary/10 text-primary',
  number: 'border-sky-300 bg-sky-100 text-sky-800',
  boolean: 'border-amber-300 bg-amber-100 text-amber-800',
  object: 'border-violet-300 bg-violet-100 text-violet-800',
  array: 'border-fuchsia-300 bg-fuchsia-100 text-fuchsia-800',
  null: 'border-zinc-300 bg-zinc-100 text-zinc-700',
}

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono text-[10px] uppercase tracking-wide px-1.5 py-0',
        TYPE_STYLES[type] ?? 'border-zinc-400/30 bg-zinc-400/10 text-zinc-300',
        className,
      )}
    >
      {type}
    </Badge>
  )
}

/** Render a stored value for display, truncating long JSON. */
export function ValuePreview({ value, type, max = 48 }: { value: unknown; type: string; max?: number }) {
  if (type === 'string') {
    const s = String(value)
    return <span className="font-mono text-sm text-foreground/90">{truncate(s, max)}</span>
  }
  if (type === 'boolean') {
    return <span className="font-mono text-sm text-amber-800">{String(value)}</span>
  }
  if (type === 'number') {
    return <span className="font-mono text-sm text-sky-700">{String(value)}</span>
  }
  const json = JSON.stringify(value)
  return <span className="font-mono text-sm text-violet-700/90">{truncate(json, max)}</span>
}

function truncate(s: string, max: number) {
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export function maskKey(key: string) {
  if (key.length <= 16) return key
  return `${key.slice(0, 12)}…${key.slice(-4)}`
}

/**
 * Mask a Telegram chat ID so only the sign + last 4 digits are visible.
 * e.g. "-1001234567890" → "-100…7890", "123456789" → "…6789".
 *
 * Used everywhere a chat ID is shown in the dashboard so the full identifier
 * (an operator secret) is never surfaced in the UI or in screenshots.
 */
export function maskChatId(id: string | null | undefined): string {
  if (!id) return '—'
  if (id.length <= 4) return '…' + id
  const sign = id.startsWith('-') ? '-' : ''
  const digits = id.replace(/^-/, '')
  return `${sign}${digits.slice(0, 3)}…${digits.slice(-4)}`
}

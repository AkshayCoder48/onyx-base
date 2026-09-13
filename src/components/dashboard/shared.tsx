'use client'

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const TYPE_STYLES: Record<string, string> = {
  string: 'border-[#f2521b]/25 bg-[#f2521b]/12 text-[#d8410f]',
  number: 'border-[#c9a227]/30 bg-[#c9a227]/14 text-[#8a6d0f]',
  boolean: 'border-emerald-500/25 bg-emerald-500/12 text-emerald-700',
  object: 'border-[#ef8f2a]/30 bg-[#ef8f2a]/14 text-[#b96a12]',
  array: 'border-[#fb7185]/25 bg-[#fb7185]/14 text-[#c2415c]',
  null: 'border-[#b1a08c]/40 bg-[#b1a08c]/16 text-[#8a7768]',
}

export function TypeBadge({ type, className }: { type: string; className?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'font-mono text-[10px] uppercase tracking-wide px-1.5 py-0',
        TYPE_STYLES[type] ?? 'border-[#8a7768]/30 bg-[#8a7768]/12 text-[#5c5049]',
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
    return <span className="font-mono text-sm text-emerald-700">{String(value)}</span>
  }
  if (type === 'number') {
    return <span className="font-mono text-sm text-[#8a6d0f]">{String(value)}</span>
  }
  const json = JSON.stringify(value)
  return <span className="font-mono text-sm text-[#b96a12]">{truncate(json, max)}</span>
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

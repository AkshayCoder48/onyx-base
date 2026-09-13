'use client'

import { useQuery } from '@tanstack/react-query'
import { Database, KeyRound, FolderTree, HardDrive, ArrowUpRight, Terminal, Zap, TrendingUp, TrendingDown } from 'lucide-react'
import { useApi, type StatsView, type RecordView, type AnalyticsView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { TypeBadge, ValuePreview, formatBytes, timeAgo } from './shared'
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts'
import { cn } from '@/lib/utils'

/* ── Warm accent set for the KPI row (coral / amber / rose / tan) ── */
const CORAL = '#f2521b'
const AMBER = '#ef8f2a'
const ROSE = '#fb7185'
const TAN = '#c9a227'

export function Overview() {
  const api = useApi()
  const user = useOnyxBase((s) => s.user)
  const setView = useOnyxBase((s) => s.setView)

  const { data: stats } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<StatsView>('/api/dashboard/stats'),
  })
  const { data: records } = useQuery({
    queryKey: ['records', 'recent'],
    queryFn: () => api<{ records: RecordView[] }>('/api/dashboard/records?'),
  })
  const { data: analytics } = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: () => api<AnalyticsView>('/api/dashboard/analytics'),
    staleTime: 30_000,
  })

  const activitySeries = stats
    ? Object.entries(stats.activityByDay)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([day, count]) => ({ day: day.slice(5), count }))
    : []

  const kpis = [
    {
      label: 'Records',
      value: stats?.records ?? '—',
      icon: Database,
      color: CORAL,
      tint: 'bg-[#f2521b]/12 text-[#f2521b] border-[#f2521b]/20',
    },
    {
      label: 'Collections',
      value: stats?.collections ?? '—',
      icon: FolderTree,
      color: AMBER,
      tint: 'bg-[#ef8f2a]/14 text-[#b96a12] border-[#ef8f2a]/25',
    },
    {
      label: 'Files',
      value: stats?.files ?? 0,
      icon: HardDrive,
      color: ROSE,
      tint: 'bg-[#fb7185]/14 text-[#c2415c] border-[#fb7185]/25',
    },
    {
      label: 'API Keys',
      value: stats?.apiKeys ?? '—',
      icon: KeyRound,
      color: TAN,
      tint: 'bg-[#c9a227]/16 text-[#8a6d0f] border-[#c9a227]/30',
    },
  ]

  /* Today vs yesterday events — honest delta pill from activityByDay. */
  const days = stats ? Object.entries(stats.activityByDay).sort((a, b) => (a[0] < b[0] ? -1 : 1)) : []
  const today = days.length ? days[days.length - 1] : null
  const yesterday = days.length > 1 ? days[days.length - 2] : null
  let delta: { text: string; up: boolean | null } | null = null
  if (today && today[1] > 0 && yesterday && yesterday[1] > 0) {
    const pct = Math.round(((today[1] - yesterday[1]) / yesterday[1]) * 1000) / 10
    delta = { text: `${Math.abs(pct)}%`, up: pct >= 0 }
  } else if (today && today[1] > 0) {
    delta = { text: `${today[1]} today`, up: true }
  }

  return (
    <div className="rise-in">
      <PageHeader
        title={`Welcome back${user?.name ? ', ' + user.name.split(' ')[0] : ''}`}
        description={`${user?.userId} · unlimited & free · connected to Telegram`}
        actions={
          <Button onClick={() => setView('database')} className="shadow-none">
            <Database className="size-4" /> Open database
          </Button>
        }
      />

      {/* ── KPI stat cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {kpis.map((c) => (
          <KpiCard key={c.label} label={c.label} value={c.value} icon={c.icon} color={c.color} tint={c.tint} spark={activitySeries} delta={delta} />
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* ── Activity area chart (2/3) ── */}
        <Card className="lg:col-span-2 p-5 bg-card/40 border-border/60">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">Activity</h3>
              <p className="text-xs text-muted-foreground">API events over the last 7 days</p>
            </div>
            <div className="flex items-center gap-3 text-[11px]">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: CORAL }} />
                <span className="text-muted-foreground">Events</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: AMBER }} />
                <span className="text-muted-foreground">Avg</span>
              </span>
              <Badge variant="default" className="font-mono tabular">
                {stats?.logs ?? 0} total
              </Badge>
            </div>
          </div>
          <div className="h-48">
            {activitySeries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={withAverage(activitySeries)} margin={{ top: 4, right: 4, bottom: 8, left: -20 }}>
                  <defs>
                    <linearGradient id="actFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CORAL} stopOpacity={0.34} />
                      <stop offset="100%" stopColor={CORAL} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 6" stroke="rgba(28,21,18,0.07)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#8a7768', fontFamily: 'var(--font-jetbrains-mono)' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#8a7768', fontFamily: 'var(--font-jetbrains-mono)' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: 'rgba(255,255,255,0.92)',
                      border: '1px solid rgba(255,255,255,0.9)',
                      borderRadius: 14,
                      fontSize: 12,
                      color: '#1c1512',
                      boxShadow: '0 10px 30px -12px rgba(120,60,20,0.28)',
                      backdropFilter: 'blur(12px)',
                    }}
                    labelStyle={{ color: '#5c5049' }}
                    cursor={{ stroke: CORAL, strokeOpacity: 0.18 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="avg"
                    stroke={AMBER}
                    strokeWidth={1.6}
                    strokeDasharray="5 5"
                    strokeOpacity={0.85}
                    fill="none"
                    isAnimationActive={false}
                    dot={false}
                  />
                  <Area type="monotone" dataKey="count" stroke={CORAL} strokeWidth={2.2} fill="url(#actFill)" dot={{ r: 2.5, fill: '#ffffff', stroke: CORAL, strokeWidth: 2 }} activeDot={{ r: 4.5, fill: CORAL, stroke: '#ffffff', strokeWidth: 2 }} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </div>
        </Card>

        {/* ── Record-type donut (1/3) ── */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="mb-2">
            <h3 className="text-sm font-semibold">Record types</h3>
            <p className="text-xs text-muted-foreground">Share of your stored values</p>
          </div>
          <TypeDonut byType={analytics?.byType ?? []} total={stats?.records ?? 0} />
        </Card>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        {/* ── Recent records table (2/3) ── */}
        <Card className="lg:col-span-2 p-5 bg-card/40 border-border/60">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Zap className="size-3.5 text-primary" /> Recent records
              </h3>
              <p className="text-xs text-muted-foreground">Latest writes across all collections</p>
            </div>
            <button onClick={() => setView('database')} className="text-xs font-medium text-primary hover:text-[#d8410f] inline-flex items-center gap-1 transition-colors">
              View all <ArrowUpRight className="size-3" />
            </button>
          </div>
          <RecordTable records={records?.records ?? []} />
        </Card>

        {/* ── Weekly activity goal (1/3) ── */}
        <Card className="p-5 bg-card/40 border-border/60">
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Weekly goal</h3>
            {stats && (
              <Badge variant="default" className="font-mono tabular">
                {sumActivity(stats)} / 1000 events
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            {stats?.logs ?? 0} API events logged this week
          </p>
          <GoalRing pct={stats ? Math.min(sumActivity(stats) / 1000, 1) : 0} />
          <div className="mt-5 space-y-3.5">
            {(analytics?.byCollection ?? []).slice(0, 3).map((c) => {
              const pct = stats?.records ? Math.round((c.records / stats.records) * 100) : 0
              return (
                <div key={c.name}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs text-[#5c5049] truncate max-w-[70%]">{c.name}</span>
                    <span className="font-mono text-[11px] tabular text-foreground">{pct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-white/50 border border-white/60 overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#f2521b] to-[#ef8f2a]"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
              )
            })}
            {(!analytics || analytics.byCollection.length === 0) && (
              <p className="text-xs text-muted-foreground">No collections yet.</p>
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   KPI card — icon chip, delta pill, big mono number, sparkline
   ───────────────────────────────────────────────────────────── */
function KpiCard({
  label,
  value,
  icon: Icon,
  color,
  tint,
  spark,
  delta,
}: {
  label: string
  value: number | string
  icon: React.ComponentType<{ className?: string }>
  color: string
  tint: string
  spark: { day: string; count: number }[]
  delta: { text: string; up: boolean | null } | null
}) {
  return (
    <Card className="p-4 bg-card/40 border-border/60 relative overflow-hidden group">
      <div className="flex items-start justify-between mb-3">
        <div className={cn('size-9 rounded-2xl grid place-items-center border', tint)}>
          <Icon className="size-[18px]" />
        </div>
        {delta && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-[11px] font-semibold tabular',
              delta.up
                ? 'bg-emerald-500/12 text-emerald-700'
                : 'bg-rose-400/14 text-[#c2415c]',
            )}
          >
            {delta.up === null ? null : delta.up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
            {delta.up === false ? '−' : '+'}{delta.text}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground mb-0.5">{label}</div>
      <div className="font-mono text-[26px] font-bold leading-none tabular tracking-tight">{value}</div>
      <Sparkline data={spark} color={color} className="mt-3" />
    </Card>
  )
}

/** Thin full-width polyline sparkline (inline SVG, no deps). */
function Sparkline({ data, color, className }: { data: { count: number }[]; color: string; className?: string }) {
  const n = Math.max(data.length, 2)
  const max = Math.max(1, ...data.map((d) => d.count))
  const w = 100
  const h = 24
  const pts = data.length
    ? data.map((d, i) => `${(i / (n - 1)) * w},${h - 3 - (d.count / max) * (h - 8)}`).join(' ')
    : `0,${h - 3} ${w},${h - 3}`
  const id = `spark-${color.replace('#', '')}`
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn('w-full h-6 block', className)}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.28} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <polygon points={`0,${h} ${pts} ${w},${h}`} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/* ─────────────────────────────────────────────────────────────
   Segmented donut — record types over a faint white track
   ───────────────────────────────────────────────────────────── */
const TYPE_COLORS: Record<string, string> = {
  string: CORAL,
  object: AMBER,
  array: ROSE,
  number: TAN,
  boolean: '#8a7768',
  null: '#b1a08c',
}

function TypeDonut({ byType, total }: { byType: { type: string; count: number }[]; total: number }) {
  const sum = byType.reduce((a, b) => a + b.count, 0)
  if (!byType.length || sum === 0) {
    return (
      <div className="h-44 grid place-items-center text-xs text-muted-foreground">
        No records yet — write your first key to see the breakdown.
      </div>
    )
  }
  const R = 62
  const C = 2 * Math.PI * R
  let offset = 0
  const segments = byType.map((s) => {
    const frac = s.count / sum
    const seg = { ...s, frac, dash: frac * C, offset }
    offset += frac * C
    return seg
  })
  return (
    <div className="flex flex-col items-center">
      <div className="relative my-2">
        <svg width="164" height="164" viewBox="0 0 164 164" className="-rotate-90">
          <circle cx="82" cy="82" r={R} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="26" />
          {segments.map((s) => (
            <circle
              key={s.type}
              cx="82"
              cy="82"
              r={R}
              fill="none"
              stroke={TYPE_COLORS[s.type] ?? '#8a7768'}
              strokeWidth="26"
              strokeLinecap="butt"
              strokeDasharray={`${Math.max(s.dash - 3, 0.1)} ${C}`}
              strokeDashoffset={-s.offset}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-mono text-[22px] font-bold tabular leading-none">{total > 999 ? `${(total / 1000).toFixed(1)}k` : total}</div>
          <div className="text-[10px] text-muted-foreground mt-1">records</div>
        </div>
      </div>
      <div className="w-full space-y-2 mt-2">
        {segments.map((s) => (
          <div key={s.type} className="flex items-center gap-2 text-xs">
            <span className="size-2.5 rounded-full shrink-0" style={{ background: TYPE_COLORS[s.type] ?? '#8a7768' }} />
            <span className="text-[#5c5049] flex-1 capitalize">{s.type}</span>
            <span className="font-mono tabular text-[11px] text-foreground">{Math.round(s.frac * 100)}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Goal ring — coral arc on faint white track
   ───────────────────────────────────────────────────────────── */
function GoalRing({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(1, pct))
  const R = 56
  const C = 2 * Math.PI * R
  const done = Math.round(clamped * 100)
  return (
    <div className="flex justify-center py-1">
      <div className="relative">
        <svg width="148" height="148" viewBox="0 0 148 148" className="-rotate-90">
          <defs>
            <linearGradient id="goalGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor={CORAL} />
              <stop offset="100%" stopColor={AMBER} />
            </linearGradient>
          </defs>
          <circle cx="74" cy="74" r={R} fill="none" stroke="rgba(255,255,255,0.55)" strokeWidth="14" />
          <circle
            cx="74"
            cy="74"
            r={R}
            fill="none"
            stroke="url(#goalGrad)"
            strokeWidth="14"
            strokeLinecap="round"
            strokeDasharray={`${clamped * C} ${C}`}
            style={{ transition: 'stroke-dasharray 0.6s ease-out' }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <div className="font-mono text-[24px] font-bold tabular leading-none">{done}%</div>
          <div className="text-[10px] text-muted-foreground mt-1">{done >= 100 ? 'goal met' : 'on track'}</div>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────────────────────────────────────────
   Recent records table — avatar, key, collection, type, time
   ───────────────────────────────────────────────────────────── */
function RecordTable({ records }: { records: RecordView[] }) {
  const setView = useOnyxBase((s) => s.setView)
  if (!records.length) {
    return (
      <div className="h-32 grid place-items-center text-xs text-muted-foreground">
        No records yet —
        <button onClick={() => setView('database')} className="text-primary hover:underline ml-1">
          create one
        </button>
      </div>
    )
  }
  return (
    <div className="overflow-x-auto scroll-slim -mx-2">
      <table className="w-full text-sm min-w-[520px]">
        <thead>
          <tr>
            {['Record', 'Collection', 'Type', 'Value', 'Updated'].map((h) => (
              <th key={h} className="text-left text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/80 px-2 pb-2.5 whitespace-nowrap">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {records.slice(0, 6).map((r) => (
            <tr key={r.collection + ':' + r.key} className="border-t border-white/40">
              <td className="px-2 py-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  <span className="size-7 rounded-xl bg-gradient-to-br from-[#f2521b]/80 to-[#ef8f2a]/70 border border-white/60 grid place-items-center text-[10px] font-mono font-bold text-white shrink-0">
                    {(r.key.slice(0, 2) || 'kv').toUpperCase()}
                  </span>
                  <span className="font-mono text-[12.5px] truncate max-w-40">{r.key}</span>
                </div>
              </td>
              <td className="px-2 py-2.5">
                <span className="text-xs text-[#5c5049]">{r.collection}</span>
              </td>
              <td className="px-2 py-2.5">
                <TypeBadge type={r.valueType} />
              </td>
              <td className="px-2 py-2.5 max-w-44">
                <ValuePreview value={r.value} type={r.valueType} max={28} />
              </td>
              <td className="px-2 py-2.5 whitespace-nowrap">
                <span className="font-mono text-[11px] tabular text-muted-foreground">{timeAgo(r.updatedAt)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ── helpers ── */
function sumActivity(stats: StatsView) {
  return Object.values(stats.activityByDay ?? {}).reduce((a, b) => a + b, 0)
}

function withAverage(series: { day: string; count: number }[]) {
  return series.map((d, i) => {
    const win = series.slice(Math.max(0, i - 2), i + 1)
    return { ...d, avg: Math.round(win.reduce((a, b) => a + b.count, 0) / win.length) }
  })
}

function EmptyChart() {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground">
      No API events in the last 7 days.
    </div>
  )
}

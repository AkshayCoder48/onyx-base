'use client'

import { useQuery } from '@tanstack/react-query'
import { Database, KeyRound, FolderTree, ScrollText, HardDrive, ArrowUpRight, Terminal, Zap } from 'lucide-react'
import { useApi, type StatsView, type RecordView } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import { TypeBadge, ValuePreview, formatBytes, timeAgo } from './shared'
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis, CartesianGrid } from 'recharts'

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

  const activitySeries = stats
    ? Object.entries(stats.activityByDay)
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([day, count]) => ({ day: day.slice(5), count }))
    : []

  const cards = [
    { label: 'Records', value: stats?.records ?? '—', icon: Database, color: 'text-primary' },
    { label: 'Collections', value: stats?.collections ?? '—', icon: FolderTree, color: 'text-sky-400' },
    { label: 'Files', value: stats?.files ?? '—', icon: HardDrive, color: 'text-violet-400' },
    { label: 'API Keys', value: stats?.apiKeys ?? '—', icon: KeyRound, color: 'text-primary' },
  ]

  return (
    <div>
      <PageHeader
        title={`Welcome back${user?.name ? ', ' + user.name : ''}`}
        description={`${user?.userId} · unlimited & free · connected to Telegram`}
        actions={
          <Button onClick={() => setView('database')} className="bg-primary hover:bg-primary/90 text-primary-foreground">
            <Database className="size-4" /> Open database
          </Button>
        }
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        {cards.map((c) => (
          <Card key={c.label} className="p-4 bg-card/40 border-border/60 relative overflow-hidden">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-muted-foreground mb-1">{c.label}</div>
                <div className="text-2xl font-semibold tracking-tight tabular-nums">{c.value}</div>
              </div>
              <c.icon className={`size-4 ${c.color}`} />
            </div>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Activity chart */}
        <Card className="lg:col-span-2 p-5 bg-card/40 border-border/60">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-medium">Activity</h3>
              <p className="text-xs text-muted-foreground">API events over the last 7 days</p>
            </div>
            <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">
              {stats?.logs ?? 0} total
            </Badge>
          </div>
          <div className="h-48">
            {activitySeries.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={activitySeries} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <defs>
                    <linearGradient id="act" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#d4744f" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#d4744f" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(43,40,37,0.08)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#6b6557' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#6b6557' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{
                      background: '#ffffff',
                      border: '1px solid #d9d4c7',
                      borderRadius: 8,
                      fontSize: 12,
                      color: '#2b2825',
                    }}
                    labelStyle={{ color: '#6b6557' }}
                    cursor={{ fill: 'rgba(212,116,79,0.08)' }}
                  />
                  <Area type="monotone" dataKey="count" stroke="#d4744f" strokeWidth={2} fill="url(#act)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyChart />
            )}
          </div>
        </Card>

        {/* Quick start */}
        <Card className="p-5 bg-card/40 border-border/60">
          <h3 className="text-sm font-medium mb-1">Quick start</h3>
          <p className="text-xs text-muted-foreground mb-4">From your terminal:</p>
          <pre className="font-mono text-[11.5px] leading-relaxed text-primary/90 bg-background/50 rounded-md p-3 border border-border/40 overflow-x-auto">
{`# store a value
$ onyx set coins 500

# read it back
$ onyx get coins
500

# list everything
$ onyx list

# full backup
$ onyx export`}
          </pre>
          <div className="mt-4 flex items-center gap-2 text-xs text-muted-foreground">
            <Terminal className="size-3.5" />
            <span>Or use the </span>
            <button onClick={() => setView('playground')} className="text-primary hover:underline inline-flex items-center gap-0.5">
              API playground <ArrowUpRight className="size-3" />
            </button>
          </div>
        </Card>
      </div>

      {/* Recent records */}
      <div className="mt-6">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium flex items-center gap-2">
            <Zap className="size-3.5 text-primary" /> Recent records
          </h3>
          <button onClick={() => setView('database')} className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
            View all <ArrowUpRight className="size-3" />
          </button>
        </div>
        <Card className="bg-card/40 border-border/60 divide-y divide-border/40">
          {records?.records?.length ? (
            records.records.slice(0, 6).map((r) => (
              // min-w-0 on every flex child so truncation works; the key is
              // capped at 40% width on mobile so the value preview always
              // gets at least half the row.
              <div key={`${r.collection}-${r.key}`} className="flex items-center gap-2 sm:gap-3 px-4 py-2.5 min-w-0">
                <code className="font-mono text-sm text-foreground/90 min-w-0 max-w-[40%] sm:max-w-[35%] truncate shrink-0">{r.key}</code>
                <TypeBadge type={r.valueType} className="shrink-0" />
                <div className="flex-1 min-w-0 truncate">
                  <ValuePreview value={r.value} type={r.valueType} max={60} />
                </div>
                <span className="text-[11px] text-muted-foreground/70 hidden sm:inline font-mono shrink-0">{timeAgo(r.updatedAt)}</span>
              </div>
            ))
          ) : (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              No records yet. Run <code className="font-mono text-primary">onyx set coins 500</code> to create your first.
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}

function EmptyChart() {
  return (
    <div className="h-full grid place-items-center text-xs text-muted-foreground/60">
      No activity yet this week
    </div>
  )
}

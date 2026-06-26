'use client'

import { useQuery } from '@tanstack/react-query'
import { Loader2, TrendingUp, Activity, FolderTree, Type } from 'lucide-react'
import { useApi, type AnalyticsView } from '@/lib/api'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from './shell'
import {
  BarChart, Bar, ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip,
  PieChart, Pie, Cell, Legend,
} from 'recharts'

const PIE_COLORS = ['#d4744f', '#e09a7a', '#b1ada1', '#8a7e6a', '#6b6557', '#e0a48f']

export function AnalyticsView() {
  const api = useApi()
  const { data, isLoading } = useQuery({
    queryKey: ['analytics'],
    queryFn: () => api<AnalyticsView>('/api/dashboard/analytics'),
  })

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Analytics" description="Usage insights across your data." />
        <div className="py-16 grid place-items-center"><Loader2 className="size-5 animate-spin text-primary" /></div>
      </div>
    )
  }

  const d = data ?? { byCollection: [], byType: [], series: [], topKeys: [], totalEvents: 0 }
  const totalRecords = d.byCollection.reduce((s, c) => s + c.records, 0)

  return (
    <div>
      <PageHeader title="Analytics" description="Usage insights across your data and API traffic." />

      {/* KPI row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5">
        <Kpi icon={Activity} label="Events (14d)" value={d.totalEvents} color="text-primary" />
        <Kpi icon={FolderTree} label="Collections" value={d.byCollection.length} color="text-sky-600" />
        <Kpi icon={TrendingUp} label="Records" value={totalRecords} color="text-primary" />
        <Kpi icon={Type} label="Value types" value={d.byType.length} color="text-violet-600" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4 mb-4">
        {/* Activity series */}
        <Card className="p-5 bg-card/40 border-border/60">
          <h3 className="text-sm font-medium mb-1">API activity</h3>
          <p className="text-xs text-muted-foreground mb-4">Events per day, last 14 days</p>
          <div className="h-56">
            {d.series.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={d.series} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(43,40,37,0.08)" vertical={false} />
                  <XAxis dataKey="day" tick={{ fontSize: 10, fill: '#6b6557' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#6b6557' }} axisLine={false} tickLine={false} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ background: '#ffffff', border: '1px solid #d9d4c7', borderRadius: 8, fontSize: 12, color: '#2b2825' }}
                    labelStyle={{ color: '#6b6557' }}
                    cursor={{ fill: 'rgba(212,116,79,0.08)' }}
                  />
                  <Bar dataKey="count" fill="#d4744f" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <Empty />
            )}
          </div>
        </Card>

        {/* Value type distribution */}
        <Card className="p-5 bg-card/40 border-border/60">
          <h3 className="text-sm font-medium mb-1">Value types</h3>
          <p className="text-xs text-muted-foreground mb-4">Distribution across all records</p>
          <div className="h-56">
            {d.byType.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={d.byType} dataKey="count" nameKey="type" cx="50%" cy="50%" innerRadius={45} outerRadius={75} paddingAngle={2}>
                    {d.byType.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} stroke="transparent" />
                    ))}
                  </Pie>
                  <Legend
                    iconType="circle"
                    wrapperStyle={{ fontSize: 11, color: '#6b6557' }}
                  />
                  <Tooltip
                    contentStyle={{ background: '#ffffff', border: '1px solid #d9d4c7', borderRadius: 8, fontSize: 12, color: '#2b2825' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <Empty />
            )}
          </div>
        </Card>
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* By collection */}
        <Card className="p-5 bg-card/40 border-border/60">
          <h3 className="text-sm font-medium mb-4">Records by collection</h3>
          <div className="space-y-2.5">
            {d.byCollection.length > 0 ? (
              d.byCollection.map((c) => {
                const pct = totalRecords > 0 ? (c.records / totalRecords) * 100 : 0
                return (
                  <div key={c.name}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <code className="font-mono text-foreground/80">{c.name}</code>
                      <span className="text-muted-foreground tabular-nums">{c.records} · {pct.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted/50 overflow-hidden">
                      <div className="h-full bg-primary/70 rounded-full" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )
              })
            ) : (
              <Empty />
            )}
          </div>
        </Card>

        {/* Top keys */}
        <Card className="p-5 bg-card/40 border-border/60">
          <h3 className="text-sm font-medium mb-4">Most active keys</h3>
          <div className="space-y-1">
            {d.topKeys.length > 0 ? (
              d.topKeys.map((k, i) => (
                <div key={k.key} className="flex items-center gap-3 py-1.5">
                  <span className="text-xs font-mono text-muted-foreground/60 w-4">{i + 1}</span>
                  <code className="font-mono text-sm flex-1 truncate">{k.key}</code>
                  <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary">{k.count}</Badge>
                </div>
              ))
            ) : (
              <Empty />
            )}
          </div>
        </Card>
      </div>
    </div>
  )
}

function Kpi({ icon: Icon, label, value, color }: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; color: string }) {
  return (
    <Card className="p-4 bg-card/40 border-border/60">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-muted-foreground mb-1">{label}</div>
          <div className="text-2xl font-semibold tabular-nums">{value}</div>
        </div>
        <Icon className={`size-4 ${color}`} />
      </div>
    </Card>
  )
}

function Empty() {
  return <div className="h-full grid place-items-center text-xs text-muted-foreground/50">No data yet</div>
}

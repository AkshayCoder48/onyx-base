'use client'

import { useState } from 'react'
import { Search, CalendarDays, ChevronDown, Bell, ArrowUpRight } from 'lucide-react'
import { Sidebar, FooterBar } from './sidebar'
import { Overview } from './overview'
import { AssistantView } from './assistant'
import { DatabaseView } from './database'
import { CollectionsView } from './collections'
import { CloudStorageView } from './storage'
import { ApiKeysView } from './api-keys'
import { EmailAutomationView } from './email-automation'
import { ShareView } from './share'
import { LogsView } from './logs'
import { AnalyticsView } from './analytics'
import { PlaygroundView } from './playground'
import { DocsView } from './docs'
import { SettingsView } from './settings'
import { DiagnosticsView } from './diagnostics'
import { ErrorBoundary } from '@/components/error-boundary'
import { useOnyxBase, type ViewKey } from '@/lib/store'
import { cn } from '@/lib/utils'

/** Human labels for the top-bar page title. */
const VIEW_TITLES: Record<ViewKey, string> = {
  assistant: 'AI Assistant',
  overview: 'Overview',
  database: 'Database',
  collections: 'Collections',
  storage: 'Cloud Storage',
  'api-keys': 'API Keys',
  'email-automation': 'Email Automation',
  share: 'Public Share',
  logs: 'Logs',
  analytics: 'Analytics',
  playground: 'API Playground',
  docs: 'Docs',
  settings: 'Settings',
  diagnostics: 'Diagnostics',
}

/** Ordered tab index — powers the directional view-transition motion. */
const VIEW_ORDER: ViewKey[] = [
  'overview', 'assistant', 'database', 'collections', 'storage',
  'api-keys', 'email-automation', 'share', 'playground', 'docs', 'logs',
  'analytics', 'diagnostics', 'settings',
]

export function DashboardShell() {
  const view = useOnyxBase((s) => s.activeView)
  const user = useOnyxBase((s) => s.user)
  const realtime = useOnyxBase((s) => s.realtimeConnected)
  const setView = useOnyxBase((s) => s.setView)

  // V6 Ultima motion: each tab switch slides the new view in from the
  // direction of travel (a tab further down the rail → slide from the
  // right), with a motion-blur fade. Direction is tracked with React's
  // documented "adjust state during render" pattern (no ref access in
  // render), and the keyed wrapper remounts per view so the animation
  // replays on every switch.
  const [prevView, setPrevView] = useState<ViewKey | null>(null)
  let direction: 'left' | 'right' = 'right'
  if (prevView !== view) {
    if (prevView !== null) {
      direction = VIEW_ORDER.indexOf(view) >= VIEW_ORDER.indexOf(prevView) ? 'right' : 'left'
    }
    setPrevView(view)
  }

  const firstName = user?.name?.split(' ')[0] ?? user?.userId ?? 'there'

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <Sidebar />
        {/* min-h-0 is REQUIRED on this div (and on main) so the flex chain
            allows shrinking. Without it, content grows beyond the viewport,
            the parent's overflow-hidden clips it, and nothing scrolls —
            which is exactly the "page is stuck" bug. */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* ── Sticky glass top bar ── */}
          <header className="sticky top-0 z-30 px-3 sm:px-4 pt-3">
            <div className="glass rounded-3xl px-4 sm:px-5 h-[60px] flex items-center gap-3">
              {/* Page title + greeting */}
              <div className="min-w-0">
                <h1 className="page-title font-display text-lg font-semibold leading-none truncate flex items-center gap-2.5">
                  <span className="truncate">{VIEW_TITLES[view] ?? 'Overview'}</span>
                  <span className="ultima-badge shrink-0" title="V6 Ultima — instant-access architecture">V6 ULTIMA</span>
                </h1>
                <p className="text-[11px] text-muted-foreground mt-1 truncate hidden sm:block">
                  {view === 'overview'
                    ? `Good to see you, ${firstName} — here's what's happening.`
                    : `Signed in as ${user?.userId ?? '…'} · unlimited & free`}
                </p>
              </div>

              {/* Right cluster — search (xl+), date pill, bell, avatar chip */}
              <div className="ml-auto flex items-center gap-2">
                {/* Glass search field with kbd hint */}
                <div className="relative hidden xl:block">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-3.5 text-[#8a7768]" />
                  <input
                    type="text"
                    placeholder="Search docs, keys, records…"
                    className="glass-soft h-9 w-56 rounded-2xl pl-9 pr-12 text-sm text-foreground placeholder:text-[#8a7768] outline-none focus:border-primary/50 focus:ring-[3px] focus:ring-primary/25 transition-shadow"
                  />
                  <kbd className="absolute right-2.5 top-1/2 -translate-y-1/2 font-mono text-[10px] text-[#8a7768] bg-white/60 border border-white/70 rounded-md px-1.5 py-0.5">
                    ⌘K
                  </kbd>
                </div>

                {/* Date-range pill */}
                <button
                  className="glass-soft h-9 rounded-2xl hidden md:inline-flex items-center gap-2 px-3.5 text-sm text-[#5c5049] hover:brightness-[1.03] transition-all"
                  onClick={() => setView('analytics')}
                  title="Activity window"
                >
                  <CalendarDays className="size-3.5 text-primary" />
                  <span className="font-medium">Last 30 days</span>
                  <ChevronDown className="size-3 text-[#8a7768]" />
                </button>

                {/* Bell — coral dot mirrors realtime connection health */}
                <button
                  className="glass-soft relative size-9 rounded-2xl grid place-items-center text-[#5c5049] hover:brightness-[1.03] transition-all"
                  title={realtime ? 'Realtime connected — live' : 'Realtime offline'}
                  aria-label="Notifications"
                  onClick={() => setView('logs')}
                >
                  <Bell className="size-4" />
                  <span
                    className={cn(
                      'absolute top-2 right-2 size-2 rounded-full',
                      realtime ? 'bg-primary pulse-dot shadow-[0_0_6px_rgba(242,82,27,0.7)]' : 'bg-[#c9b8a8]',
                    )}
                  />
                </button>

                {/* Avatar chip — photo-initials + name + plan */}
                <button
                  className="glass-soft h-9 rounded-2xl hidden sm:flex items-center gap-2.5 pl-1.5 pr-3.5 hover:brightness-[1.03] transition-all"
                  onClick={() => setView('settings')}
                  title="Account settings"
                >
                  <span className="size-7 rounded-xl bg-gradient-to-br from-[#f2521b] via-[#ef8f2a] to-[#d8410f] flex items-center justify-center text-[11px] font-mono font-bold text-white shadow-[0_4px_10px_-4px_rgba(242,82,27,0.6)]">
                    {user?.userId?.slice(4, 6).toUpperCase() ?? 'KV'}
                  </span>
                  <span className="text-left leading-tight">
                    <span className="block text-[12px] font-semibold text-foreground truncate max-w-28">
                      {user?.name ?? 'Developer'}
                    </span>
                    <span className="block text-[10px] text-muted-foreground">
                      {user?.isAdmin ? 'admin · unlimited' : user?.plan ?? 'unlimited'}
                    </span>
                  </span>
                </button>
              </div>
            </div>
          </header>

          {/* ── Main scroll area ── */}
          <main className="flex-1 min-h-0 overflow-y-auto scroll-slim overscroll-contain">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
              {/* ErrorBoundary per-view so a broken view doesn't take down the
                  rest of the dashboard. The user can recover with one click.
                  NOTE: the assistant intentionally escapes this padding
                  (-my-6/lg:-my-8 in its own wrapper) for a full-height chat
                  surface — keep that in mind when adding new views.
                  The keyed wrapper replays the directional slide+blur motion
                  on every tab switch (V6 Ultima motion system). */}
              <div key={view} className={direction === 'right' ? 'view-enter-right' : 'view-enter-left'}>
                <ErrorBoundary>
                  {view === 'overview' && <Overview />}
                  {view === 'assistant' && <AssistantView />}
                  {view === 'database' && <DatabaseView />}
                  {view === 'collections' && <CollectionsView />}
                  {view === 'storage' && <CloudStorageView />}
                  {view === 'api-keys' && <ApiKeysView />}
                  {view === 'email-automation' && <EmailAutomationView />}
                  {view === 'share' && <ShareView />}
                  {view === 'logs' && <LogsView />}
                  {view === 'analytics' && <AnalyticsView />}
                  {view === 'playground' && <PlaygroundView />}
                  {view === 'docs' && <DocsView />}
                  {view === 'settings' && <SettingsView />}
                  {view === 'diagnostics' && <DiagnosticsView />}
                </ErrorBoundary>
              </div>
            </div>
          </main>
          <FooterBar />
        </div>
      </div>
    </div>
  )
}

/** Page header used by each section. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-5 sm:mb-6">
      <div className="space-y-1 min-w-0">
        {/* text-xl on mobile to save vertical space; text-2xl from sm up. */}
        <h2 className="page-title text-xl sm:text-2xl font-semibold tracking-tight break-words">{title}</h2>
        {description && <p className="text-sm text-muted-foreground break-words">{description}</p>}
      </div>
      {actions && (
        // flex-wrap so a long actions row collapses gracefully on phones.
        <div className="flex items-center gap-2 flex-wrap">{actions}</div>
      )}
    </div>
  )
}

/** Small coral "View all →" link used across section headers. */
export function ViewAllLink({ onClick, children }: { onClick: () => void; children?: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="text-xs font-medium text-primary hover:text-[#d8410f] inline-flex items-center gap-1 transition-colors"
    >
      {children ?? 'View all'} <ArrowUpRight className="size-3" />
    </button>
  )
}

'use client'

import { Sidebar, FooterBar } from './sidebar'
import { Overview } from './overview'
import { DatabaseView } from './database'
import { CollectionsView } from './collections'
import { CloudStorageView } from './storage'
import { ApiKeysView } from './api-keys'
import { ShareView } from './share'
import { LogsView } from './logs'
import { AnalyticsView } from './analytics'
import { PlaygroundView } from './playground'
import { SqlEditorView } from './sql-editor'
import { TablesView } from './tables'
import { DocsView } from './docs'
import { SettingsView } from './settings'
import { useOnyxBase } from '@/lib/store'

export function DashboardShell() {
  const view = useOnyxBase((s) => s.activeView)

  return (
    <div className="h-dvh flex flex-col overflow-hidden">
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <Sidebar />
        {/* min-h-0 is REQUIRED on this div (and on main) so the flex chain
            allows shrinking. Without it, content grows beyond the viewport,
            the parent's overflow-hidden clips it, and nothing scrolls —
            which is exactly the "page is stuck" bug. */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          <main className="flex-1 min-h-0 overflow-y-auto scroll-slim overscroll-contain">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
              {view === 'overview' && <Overview />}
              {view === 'database' && <DatabaseView />}
              {view === 'collections' && <CollectionsView />}
              {view === 'storage' && <CloudStorageView />}
              {view === 'api-keys' && <ApiKeysView />}
              {view === 'share' && <ShareView />}
              {view === 'logs' && <LogsView />}
              {view === 'analytics' && <AnalyticsView />}
              {view === 'playground' && <PlaygroundView />}
              {view === 'sql' && <SqlEditorView />}
              {view === 'tables' && <TablesView />}
              {view === 'docs' && <DocsView />}
              {view === 'settings' && <SettingsView />}
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
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight break-words">{title}</h1>
        {description && <p className="text-sm text-muted-foreground break-words">{description}</p>}
      </div>
      {actions && (
        // flex-wrap so a long actions row collapses gracefully on phones.
        <div className="flex items-center gap-2 flex-wrap">{actions}</div>
      )}
    </div>
  )
}

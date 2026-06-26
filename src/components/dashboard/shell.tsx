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
import { DocsView } from './docs'
import { SettingsView } from './settings'
import { useOnyxBase } from '@/lib/store'

export function DashboardShell() {
  const view = useOnyxBase((s) => s.activeView)

  return (
    <div className="min-h-screen flex flex-col">
      <div className="flex flex-col lg:flex-row flex-1 min-h-0">
        <Sidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <main className="flex-1 overflow-y-auto scroll-slim">
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
    <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

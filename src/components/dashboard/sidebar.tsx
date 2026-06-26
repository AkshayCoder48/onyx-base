'use client'

import { useState } from 'react'
import {
  LayoutDashboard,
  Database,
  FolderTree,
  HardDrive,
  KeyRound,
  Share2,
  ScrollText,
  BarChart3,
  TerminalSquare,
  BookOpen,
  Settings,
  LogOut,
  Menu,
  X,
  Github,
} from 'lucide-react'
import { useOnyxBase, type ViewKey } from '@/lib/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { toast } from 'sonner'
import { RealtimeIndicator } from './realtime-indicator'

interface NavItem {
  key: ViewKey
  label: string
  icon: React.ComponentType<{ className?: string }>
  hint?: string
}

const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Workspace',
    items: [
      { key: 'overview', label: 'Dashboard', icon: LayoutDashboard },
      { key: 'database', label: 'Database', icon: Database },
      { key: 'collections', label: 'Collections', icon: FolderTree },
      { key: 'storage', label: 'Cloud Storage', icon: HardDrive },
    ],
  },
  {
    group: 'Develop',
    items: [
      { key: 'api-keys', label: 'API Keys', icon: KeyRound },
      { key: 'share', label: 'Public Share', icon: Share2 },
      { key: 'playground', label: 'API Playground', icon: TerminalSquare },
      { key: 'docs', label: 'Docs', icon: BookOpen },
      { key: 'logs', label: 'Logs', icon: ScrollText },
      { key: 'analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    group: 'Account',
    items: [{ key: 'settings', label: 'Settings', icon: Settings }],
  },
]

export function Sidebar() {
  const activeView = useOnyxBase((s) => s.activeView)
  const setView = useOnyxBase((s) => s.setView)
  const user = useOnyxBase((s) => s.user)
  const clearSession = useOnyxBase((s) => s.clearSession)
  const [mobileOpen, setMobileOpen] = useState(false)

  function logout() {
    clearSession()
    toast.success('Signed out')
  }

  const content = (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-border/60">
        <img src="/logo.png" alt="Onyx Base" className="size-7 rounded-md object-cover" />
        <span className="font-mono text-sm tracking-tight">Onyx Base</span>
        <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary uppercase">
          free
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto scroll-slim px-2.5 py-4 space-y-5">
        {NAV.map((section) => (
          <div key={section.group} className="space-y-1">
            <div className="px-2.5 mb-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
              {section.group}
            </div>
            {section.items.map((item) => {
              const active = activeView === item.key
              return (
                <button
                  key={item.key}
                  onClick={() => {
                    setView(item.key)
                    setMobileOpen(false)
                  }}
                  className={cn(
                    'w-full group flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors',
                    active
                      ? 'bg-primary/10 text-primary border border-primary/20'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-transparent',
                  )}
                >
                  <item.icon className={cn('size-4', active ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground')} />
                  <span className="flex-1 text-left">{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>

      {/* User card */}
      <div className="border-t border-border/60 p-3 space-y-2">
        <div className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-md bg-muted/40">
          <div className="size-7 rounded-md bg-gradient-to-br from-primary/30 to-primary/20 border border-primary/30 flex items-center justify-center text-[11px] font-mono text-primary">
            {user?.userId?.slice(4, 6).toUpperCase() ?? 'KV'}
          </div>
          <div className="min-w-0 flex-1">
            <div className="font-mono text-xs truncate text-foreground">{user?.userId}</div>
            <div className="text-[10px] text-muted-foreground">unlimited &amp; free</div>
          </div>
          <RealtimeIndicator />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={logout}
          className="w-full justify-start text-muted-foreground hover:text-foreground h-8"
        >
          <LogOut className="size-3.5" /> Sign out
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile top bar */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center gap-2 h-12 px-3 border-b border-border/60 bg-background/80 backdrop-blur">
        <button
          onClick={() => setMobileOpen(true)}
          className="size-8 grid place-items-center rounded-md hover:bg-muted"
          aria-label="Open menu"
        >
          <Menu className="size-4" />
        </button>
        <div className="flex items-center gap-2">
          <img src="/logo.png" alt="Onyx Base" className="size-6 rounded-md object-cover" />
          <span className="font-mono text-sm">Onyx Base</span>
        </div>
      </div>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div className="absolute inset-0 bg-black/60" onClick={() => setMobileOpen(false)} />
          <div className="relative w-72 max-w-[80%] bg-sidebar border-r border-border/60">
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-3 size-8 grid place-items-center rounded-md hover:bg-muted"
            >
              <X className="size-4" />
            </button>
            {content}
          </div>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-60 shrink-0 border-r border-border/60 bg-sidebar/50">
        {content}
      </aside>
    </>
  )
}

export function FooterBar() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-sidebar/30">
      <div className="px-4 sm:px-6 h-11 flex items-center justify-between text-[11px] text-muted-foreground/70">
        <div className="flex items-center gap-3">
          <span className="font-mono">Onyx Base</span>
          <span className="hidden sm:inline">·</span>
          <span className="hidden sm:inline">Telegram-backed key-value store</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="hidden sm:flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-primary pulse-dot" /> all systems operational
          </span>
          <a
            href="#"
            className="flex items-center gap-1 hover:text-foreground transition-colors"
            onClick={(e) => e.preventDefault()}
          >
            <Github className="size-3" /> docs
          </a>
        </div>
      </div>
    </footer>
  )
}

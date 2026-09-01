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
  Code2,
  Table2,
  Activity,
  MailCheck,
  Sun,
  HelpCircle,
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
      { key: 'email-otp', label: 'Email OTP', icon: MailCheck },
      { key: 'share', label: 'Public Share', icon: Share2 },
      { key: 'playground', label: 'API Playground', icon: TerminalSquare },
      { key: 'sql', label: 'SQL Editor', icon: Code2 },
      { key: 'tables', label: 'Tables', icon: Table2 },
      { key: 'docs', label: 'Docs', icon: BookOpen },
      { key: 'logs', label: 'Logs', icon: ScrollText },
      { key: 'analytics', label: 'Analytics', icon: BarChart3 },
    ],
  },
  {
    group: 'Account',
    items: [
      { key: 'diagnostics', label: 'Diagnostics', icon: Activity, hint: 'System health, queue, errors' },
      { key: 'settings', label: 'Settings', icon: Settings },
    ],
  },
]

/** Sunrise logo mark — coral→amber gradient square with a white sun. */
function LogoMark({ size = 'size-10' }: { size?: string }) {
  return (
    <div
      className={cn(
        size,
        'rounded-2xl bg-gradient-to-br from-[#f2521b] via-[#ef8f2a] to-[#d8410f]',
        'flex items-center justify-center shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_8px_20px_-8px_rgba(242,82,27,0.6)]',
      )}
      aria-label="Onyx Base"
    >
      {/* Inline SVG sun — no icon font, always renders. */}
      <svg viewBox="0 0 24 24" fill="none" className="size-1/2 text-white" aria-hidden="true">
        <circle cx="12" cy="12" r="4.4" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="12" y1="2.2" x2="12" y2="4.6" />
          <line x1="12" y1="19.4" x2="12" y2="21.8" />
          <line x1="2.2" y1="12" x2="4.6" y2="12" />
          <line x1="19.4" y1="12" x2="21.8" y2="12" />
          <line x1="5.06" y1="5.06" x2="6.76" y2="6.76" />
          <line x1="17.24" y1="17.24" x2="18.94" y2="18.94" />
          <line x1="5.06" y1="18.94" x2="6.76" y2="17.24" />
          <line x1="17.24" y1="6.76" x2="18.94" y2="5.06" />
        </g>
      </svg>
    </div>
  )
}

/** A single icon-rail nav button — 48px hit area, tooltip on hover, active = coral gradient. */
function RailItem({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  const Icon = item.icon
  return (
    <button
      onClick={onClick}
      title={item.label}
      aria-label={item.label}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative size-12 rounded-2xl grid place-items-center transition-all duration-150 shrink-0',
        active
          ? 'bg-gradient-to-br from-[#f2521b] to-[#d8410f] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.3),0_8px_18px_-8px_rgba(242,82,27,0.65)]'
          : 'text-[#8a7768] hover:text-[#1c1512] hover:bg-white/60 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.6)]',
      )}
    >
      <Icon className="size-[22px]" strokeWidth={active ? 2.2 : 2} />
    </button>
  )
}

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

  /* ── Mobile drawer content: labels + icons (roomier list) ── */
  const mobileContent = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-4 h-14 border-b border-white/50">
        <LogoMark size="size-8" />
        <span className="font-display text-sm font-semibold tracking-tight">Onyx Base</span>
        <span className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded-full border border-primary/30 bg-primary/10 text-primary uppercase">
          free
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto scroll-slim px-2.5 py-4 space-y-5 overscroll-contain">
        {NAV.map((section) => (
          <div key={section.group} className="space-y-1">
            <div className="px-2.5 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
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
                    'w-full group flex items-center gap-2.5 rounded-2xl px-2.5 py-2.5 min-h-[40px] text-sm font-medium transition-all',
                    active
                      ? 'bg-gradient-to-r from-[#f2521b] to-[#d8410f] text-white shadow-[0_8px_18px_-8px_rgba(242,82,27,0.6)]'
                      : 'text-[#5c5049] hover:text-[#1c1512] hover:bg-white/60',
                  )}
                >
                  <item.icon className={cn('size-4 shrink-0', active ? 'text-white' : 'text-[#8a7768]')} />
                  <span className="flex-1 text-left truncate">{item.label}</span>
                </button>
              )
            })}
          </div>
        ))}
      </nav>
      <div className="border-t border-white/50 p-3 space-y-2">
        <div className="flex items-center gap-2.5 px-1.5 py-1.5 rounded-2xl bg-white/50">
          <div className="size-7 rounded-xl bg-gradient-to-br from-[#f2521b] to-[#ef8f2a] border border-white/60 flex items-center justify-center text-[11px] font-mono font-semibold text-white">
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
          className="w-full justify-start text-muted-foreground hover:text-foreground h-9 rounded-xl"
        >
          <LogOut className="size-3.5" /> Sign out
        </Button>
      </div>
    </div>
  )

  return (
    <>
      {/* Mobile top bar — glass */}
      <div className="lg:hidden sticky top-0 z-40 flex items-center gap-2 h-12 px-3 border-b border-white/50 bg-white/60 backdrop-blur-md">
        <button
          onClick={() => setMobileOpen(true)}
          className="size-9 grid place-items-center rounded-xl hover:bg-white/70 active:bg-white/60"
          aria-label="Open menu"
        >
          <Menu className="size-4" />
        </button>
        <div className="flex items-center gap-2">
          <LogoMark size="size-6" />
          <span className="font-display text-sm font-semibold">Onyx Base</span>
        </div>
        <div className="ml-auto"><RealtimeIndicator /></div>
      </div>

      {/* Mobile drawer — compositor-friendly slide. Glass panel over dimmed aurora. */}
      <div
        className="lg:hidden fixed inset-0 z-50"
        style={{ pointerEvents: mobileOpen ? 'auto' : 'none' }}
        aria-hidden={!mobileOpen}
      >
        <div
          onClick={() => setMobileOpen(false)}
          className={cn(
            'absolute inset-0 bg-[#3a2010]/50 backdrop-blur-sm transition-opacity duration-200 ease-out',
            mobileOpen ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div
          className={cn(
            'relative w-72 max-w-[80%] h-full bg-white/80 backdrop-blur-2xl border-r border-white/60 shadow-xl transition-transform duration-200 ease-out',
            mobileOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <button
            onClick={() => setMobileOpen(false)}
            className="absolute right-2 top-3 size-9 grid place-items-center rounded-xl hover:bg-white/70"
            aria-label="Close menu"
          >
            <X className="size-4" />
          </button>
          {mobileContent}
        </div>
      </div>

      {/* ── Desktop icon rail — slim floating glass rail ── */}
      <aside className="hidden lg:flex w-[76px] shrink-0 py-3 pl-3">
        <div className="glass rounded-3xl w-full flex flex-col items-center py-4 gap-3 overflow-hidden">
          {/* Logo mark */}
          <div className="px-1">
            <LogoMark />
          </div>

          {/* Nav icons — scrollable middle, grouped with hairline dividers */}
          <nav className="flex-1 overflow-y-auto scroll-slim w-full flex flex-col items-center gap-1.5 px-3 overscroll-contain">
            {NAV.map((section, i) => (
              <div key={section.group} className="w-full flex flex-col items-center gap-1.5">
                {i > 0 && <div className="w-8 h-px bg-white/60 my-1.5" />}
                {section.items.map((item) => (
                  <RailItem
                    key={item.key}
                    item={item}
                    active={activeView === item.key}
                    onClick={() => setView(item.key)}
                  />
                ))}
              </div>
            ))}
          </nav>

          {/* Pinned bottom: help + avatar */}
          <div className="w-full flex flex-col items-center gap-2 pt-1">
            <button
              onClick={() => setView('docs')}
              title="Help & docs"
              aria-label="Help & docs"
              className="size-12 rounded-2xl grid place-items-center text-[#8a7768] hover:text-[#1c1512] hover:bg-white/60 transition-all"
            >
              <HelpCircle className="size-[22px]" strokeWidth={2} />
            </button>
            <div
              title={user?.userId ?? 'Account'}
              className="size-10 rounded-full bg-gradient-to-br from-[#f2521b] via-[#ef8f2a] to-[#d8410f] border-2 border-white/70 flex items-center justify-center text-xs font-mono font-bold text-white shadow-[0_6px_16px_-6px_rgba(242,82,27,0.6)] cursor-pointer"
              onClick={() => setView('settings')}
              role="button"
              aria-label="Account & settings"
            >
              {user?.userId?.slice(4, 6).toUpperCase() ?? 'KV'}
            </div>
            <button
              onClick={logout}
              title="Sign out"
              aria-label="Sign out"
              className="size-9 rounded-xl grid place-items-center text-[#8a7768]/70 hover:text-destructive hover:bg-destructive/10 transition-all"
            >
              <LogOut className="size-4" />
            </button>
          </div>
        </div>
      </aside>
    </>
  )
}

export function FooterBar() {
  return (
    <footer className="mt-auto">
      <div className="mx-3 mb-3 glass-soft rounded-2xl px-4 h-11 flex items-center justify-between text-[11px] text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="font-display font-semibold text-foreground/70">Onyx Base</span>
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

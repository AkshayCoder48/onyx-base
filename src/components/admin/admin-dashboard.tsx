'use client'

import { useState, useEffect, useCallback, useMemo, Fragment } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Shield,
  Users,
  FileText,
  KeyRound,
  ArrowLeft,
  LogOut,
  Loader2,
  Search,
  RefreshCw,
  Copy,
  Check,
  Link2,
  Trash2,
  ExternalLink,
  Clock,
  Timer,
  Lock,
  Unlock,
  Server,
  ShieldCheck,
  ShieldAlert,
  Plus,
  ChevronRight,
  Database as DbIcon,
  Folder,
  File as FileIcon,
  AlertCircle,
  Info,
} from 'lucide-react'
import { useApi } from '@/lib/api'
import { useOnyxBase } from '@/lib/store'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import { TypeBadge, formatBytes, timeAgo, maskKey } from '@/components/dashboard/shared'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

/* ===================================================================
 *  Types — these mirror the admin API response shapes (Task 13).
 * =================================================================== */

interface GlobalStats {
  users: number
  records: number
  files: number
  fileBytes: number
  apiKeys: number
  activeApiKeys: number
  collections: number
  adminKeys: number
}

interface AdminUserSummary {
  id: string
  userId: string
  name: string | null
  email: string | null
  plan: string
  createdAt: string
  stats: {
    apiKeys: number
    activeApiKeys: number
    records: number
    collections: number
    files: number
    fileBytes: number
  }
}

interface AdminFileSummary {
  id: string
  fileId: string
  fileName: string
  mimeType: string
  size: number
  isPublic: boolean
  downloads: number
  storageMode: 'server' | 'custom'
  label: string | null
  createdAt: string
  owner: { id: string; userId: string; name: string | null; email: string | null }
}

interface AdminApiKeyView {
  id: string
  name: string
  keyPrefix: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

interface AdminRecordView {
  id: string
  collection: string
  key: string
  value: unknown
  valueType: string
  createdAt: string
  updatedAt: string
}

interface AdminUserFile {
  id: string
  fileId: string
  fileName: string
  mimeType: string
  size: number
  isPublic: boolean
  downloads: number
  storageMode: 'server' | 'custom'
  label: string | null
  createdAt: string
}

interface AdminCollectionView {
  name: string
  count: number
  createdAt: string
}

interface AdminKeyView {
  id: string
  key: string
  label: string
  createdAt: string
  createdBy: string
  promotedFromUserEmail: string | null
  isBootstrap: boolean
  revoked: boolean
}

type AdminTab = 'users' | 'files' | 'admins'

/* ===================================================================
 *  Telegram link cache (localStorage, 55-min TTL).
 * =================================================================== */

const LINK_TTL_MS = 55 * 60 * 1000
const LINK_KEY_PREFIX = 'onyx_admin_link_'

interface CachedLink {
  url: string
  expiresAt: number
}

function loadCachedLink(fileId: string): CachedLink | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LINK_KEY_PREFIX + fileId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedLink
    if (!parsed?.url || typeof parsed.expiresAt !== 'number') return null
    if (parsed.expiresAt <= Date.now()) {
      localStorage.removeItem(LINK_KEY_PREFIX + fileId)
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function saveCachedLink(fileId: string, url: string, expiresAt: number) {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LINK_KEY_PREFIX + fileId, JSON.stringify({ url, expiresAt }))
  } catch {
    /* storage full or disabled — non-fatal */
  }
}

function clearCachedLink(fileId: string) {
  if (typeof window === 'undefined') return
  try {
    localStorage.removeItem(LINK_KEY_PREFIX + fileId)
  } catch {
    /* ignore */
  }
}

/** Sweep all `onyx_admin_link_*` keys on mount and purge any that are expired. */
function cleanupExpiredLinks() {
  if (typeof window === 'undefined') return
  try {
    const toDelete: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (!k || !k.startsWith(LINK_KEY_PREFIX)) continue
      try {
        const parsed = JSON.parse(localStorage.getItem(k) ?? 'null') as CachedLink | null
        if (!parsed || typeof parsed.expiresAt !== 'number' || parsed.expiresAt <= Date.now()) {
          toDelete.push(k)
        }
      } catch {
        toDelete.push(k)
      }
    }
    for (const k of toDelete) localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}

function formatCountdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return 'expired'
  const h = Math.floor(secondsLeft / 3600)
  const m = Math.floor((secondsLeft % 3600) / 60)
  const s = secondsLeft % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

/* ===================================================================
 *  Main AdminDashboard component.
 * =================================================================== */

export function AdminDashboard() {
  const user = useOnyxBase((s) => s.user)
  const setAdminMode = useOnyxBase((s) => s.setAdminMode)
  const clearSession = useOnyxBase((s) => s.clearSession)
  const [activeTab, setActiveTab] = useState<AdminTab>('users')
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null)

  // Cleanup expired localStorage link entries on mount.
  useEffect(() => {
    cleanupExpiredLinks()
  }, [])

  // Global stats for the header.
  const api = useApi()
  const { data: statsData } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api<{ stats: GlobalStats }>('/api/admin/users'),
    refetchInterval: 30_000,
  })
  const stats = statsData?.stats

  function logout() {
    clearSession()
    toast.success('Signed out')
  }

  function switchToRegular() {
    setAdminMode(false)
  }

  return (
    <div className="h-dvh flex flex-col bg-background overflow-hidden">
      {/* ─── Header bar ─────────────────────────────────────────────── */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/95 backdrop-blur">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3 h-14">
            <img src="/logo.png" alt="Onyx Base" className="size-7 rounded-md object-cover" />
            <span className="font-mono text-sm tracking-tight hidden sm:inline">Onyx Base</span>
            <Badge className="bg-red-500/15 text-red-600 border-red-500/30 hover:bg-red-500/15 uppercase font-mono text-[10px] tracking-wider">
              <Shield className="size-3 mr-1" /> Admin
            </Badge>

            {/* Global stats — compact pill row */}
            <div className="hidden md:flex items-center gap-1.5 ml-2">
              <StatPill icon={Users} label="Users" value={stats?.users} />
              <StatPill icon={DbIcon} label="Records" value={stats?.records} />
              <StatPill icon={FileText} label="Files" value={stats?.files} />
              <StatPill icon={Folder} label="Colls" value={stats?.collections} />
              <StatPill icon={KeyRound} label="API Keys" value={stats?.apiKeys} />
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="hidden lg:flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/60 text-[11px] text-muted-foreground font-mono">
                <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
                admin session · {user?.userId}
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={switchToRegular}
                title="Switch back to the regular developer dashboard"
                className="h-8"
              >
                <ArrowLeft className="size-3.5" />
                <span className="hidden sm:inline">Regular dashboard</span>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={logout}
                className="h-8 text-muted-foreground hover:text-foreground"
              >
                <LogOut className="size-3.5" />
                <span className="hidden sm:inline">Sign out</span>
              </Button>
            </div>
          </div>

          {/* Mobile stats strip */}
          <div className="md:hidden flex items-center gap-1.5 pb-2 -mt-1 overflow-x-auto">
            <StatPill icon={Users} label="Users" value={stats?.users} />
            <StatPill icon={DbIcon} label="Records" value={stats?.records} />
            <StatPill icon={FileText} label="Files" value={stats?.files} />
            <StatPill icon={Folder} label="Colls" value={stats?.collections} />
            <StatPill icon={KeyRound} label="Keys" value={stats?.apiKeys} />
          </div>
        </div>

        {/* Tab nav */}
        <div className="border-t border-border/40 bg-sidebar/30">
          <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8">
            <nav className="flex items-center gap-1 h-11 overflow-x-auto">
              <TabButton
                active={activeTab === 'users' && !selectedUserId}
                onClick={() => {
                  setSelectedUserId(null)
                  setActiveTab('users')
                }}
                icon={Users}
                label="Users"
              />
              <TabButton
                active={activeTab === 'files'}
                onClick={() => {
                  setSelectedUserId(null)
                  setActiveTab('files')
                }}
                icon={FileText}
                label="All Files"
              />
              <TabButton
                active={activeTab === 'admins'}
                onClick={() => {
                  setSelectedUserId(null)
                  setActiveTab('admins')
                }}
                icon={ShieldCheck}
                label="Admins"
              />
            </nav>
          </div>
        </div>
      </header>

      {/* ─── Main content ──────────────────────────────────────────── */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 py-6 lg:py-8">
          {activeTab === 'users' && selectedUserId && (
            <UserDetail userId={selectedUserId} onBack={() => setSelectedUserId(null)} />
          )}
          {activeTab === 'users' && !selectedUserId && (
            <UsersList onSelectUser={(id) => setSelectedUserId(id)} />
          )}
          {activeTab === 'files' && <AllFilesView />}
          {activeTab === 'admins' && <AdminsView />}
        </div>
      </main>

      <footer className="mt-auto border-t border-border/60 bg-sidebar/30">
        <div className="mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8 h-11 flex items-center justify-between text-[11px] text-muted-foreground/70">
          <div className="flex items-center gap-3">
            <span className="font-mono">Onyx Base · Admin</span>
            <span className="hidden sm:inline">·</span>
            <span className="hidden sm:inline">Operator-only dashboard</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="size-1.5 rounded-full bg-red-500 animate-pulse" />
            <span>admin mode</span>
          </div>
        </div>
      </footer>
    </div>
  )
}

/* ===================================================================
 *  Small shared primitives.
 * =================================================================== */

function StatPill({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  value?: number
}) {
  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-muted/60 border border-border/40 text-[11px]"
      title={label}
    >
      <Icon className="size-3 text-muted-foreground" />
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono font-semibold tabular-nums text-foreground">
        {value ?? '—'}
      </span>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean
  onClick: () => void
  icon: React.ComponentType<{ className?: string }>
  label: string
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 px-3 h-9 rounded-md text-sm transition-colors whitespace-nowrap border-b-2 -mb-px',
        active
          ? 'text-primary border-primary'
          : 'text-muted-foreground hover:text-foreground border-transparent',
      )}
    >
      <Icon className="size-3.5" />
      {label}
    </button>
  )
}

function PageHeader({
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

/* ===================================================================
 *  Users tab — list all users.
 * =================================================================== */

function UsersList({ onSelectUser }: { onSelectUser: (id: string) => void }) {
  const api = useApi()
  const [search, setSearch] = useState('')

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<{ users: AdminUserSummary[]; stats: GlobalStats }>(
      '/api/admin/users',
    ),
  })

  const users = useMemo(() => {
    const list = data?.users ?? []
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter(
      (u) =>
        (u.name ?? '').toLowerCase().includes(q) ||
        (u.email ?? '').toLowerCase().includes(q) ||
        u.userId.toLowerCase().includes(q),
    )
  }, [data, search])

  return (
    <div>
      <PageHeader
        title="Users"
        description="Every developer account on this Onyx Base instance. Click a row to drill into their data."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} title="Refresh">
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
          </Button>
        }
      />

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or userId…"
          className="pl-9 h-9"
        />
      </div>

      <Card className="bg-card/40 border-border/60 overflow-hidden">
        {isLoading ? (
          <div className="py-16 grid place-items-center">
            <Loader2 className="size-5 animate-spin text-primary" />
          </div>
        ) : users.length === 0 ? (
          <div className="py-16 px-6 text-center">
            <Users className="size-8 mx-auto mb-3 text-muted-foreground/50" />
            <p className="text-sm font-medium">{search ? 'No matches' : 'No users yet'}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {search ? 'Try a different search term.' : 'New signups will appear here.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[calc(100vh-280px)] overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
                <TableRow className="hover:bg-transparent border-border/40">
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Email</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden md:table-cell">UserID</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right">Records</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right hidden sm:table-cell">Colls</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right hidden sm:table-cell">Files</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right hidden lg:table-cell">API Keys</TableHead>
                  <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden md:table-cell">Created</TableHead>
                  <TableHead className="w-[44px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow
                    key={u.id}
                    onClick={() => onSelectUser(u.id)}
                    className="cursor-pointer border-border/30 hover:bg-primary/[0.04] group"
                  >
                    <TableCell className="py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="size-8 rounded-md bg-gradient-to-br from-primary/30 to-primary/10 border border-primary/20 flex items-center justify-center text-[11px] font-mono text-primary shrink-0">
                          {(u.name ?? u.userId).slice(0, 2).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-foreground/90 truncate">
                            {u.name ?? 'Unnamed'}
                          </div>
                          <div className="text-[11px] text-muted-foreground font-mono md:hidden truncate">
                            {u.userId}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="py-2.5 text-sm text-muted-foreground truncate max-w-[220px]">
                      {u.email ?? '—'}
                    </TableCell>
                    <TableCell className="py-2.5 hidden md:table-cell">
                      <span className="font-mono text-[11px] text-muted-foreground/80">{u.userId}</span>
                    </TableCell>
                    <TableCell className="py-2.5 text-right font-mono text-sm tabular-nums">
                      {u.stats.records}
                    </TableCell>
                    <TableCell className="py-2.5 text-right font-mono text-sm tabular-nums hidden sm:table-cell">
                      {u.stats.collections}
                    </TableCell>
                    <TableCell className="py-2.5 text-right font-mono text-sm tabular-nums hidden sm:table-cell">
                      {u.stats.files}
                    </TableCell>
                    <TableCell className="py-2.5 text-right hidden lg:table-cell">
                      <span className="font-mono text-sm tabular-nums">{u.stats.apiKeys}</span>
                      {u.stats.activeApiKeys < u.stats.apiKeys && (
                        <span className="ml-1 text-[10px] text-amber-600">
                          ({u.stats.activeApiKeys} active)
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="py-2.5 hidden md:table-cell text-[11px] text-muted-foreground/70 font-mono">
                      {timeAgo(u.createdAt)}
                    </TableCell>
                    <TableCell className="py-2.5 text-right">
                      <ChevronRight className="size-4 text-muted-foreground/40 group-hover:text-primary transition-colors" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <div className="mt-3 text-xs text-muted-foreground/70 font-mono">
        {users.length} user{users.length === 1 ? '' : 's'}
        {search && ` · filtered from ${data?.users.length ?? 0}`}
      </div>
    </div>
  )
}

/* ===================================================================
 *  User detail view — shown when a user is selected.
 * =================================================================== */

interface UserDetailResponse {
  user: {
    id: string
    userId: string
    name: string | null
    email: string | null
    plan: string
    createdAt: string
  }
  apiKeys: AdminApiKeyView[]
  records: AdminRecordView[]
  files: AdminUserFile[]
  collections: AdminCollectionView[]
  telegramConfig: {
    chatId: string
    label: string
    hasCustomBotToken: boolean
  } | null
}

function UserDetail({ userId, onBack }: { userId: string; onBack: () => void }) {
  const api = useApi()
  const [subTab, setSubTab] = useState<'collections' | 'keyvalues' | 'files' | 'apikeys'>(
    'keyvalues',
  )

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'user', userId],
    queryFn: () => api<UserDetailResponse>(`/api/admin/users/${userId}`),
  })

  if (isLoading) {
    return (
      <div className="py-24 grid place-items-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    )
  }

  if (!data) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
          <ArrowLeft className="size-4" /> Back to users
        </Button>
        <Card className="p-10 text-center text-sm text-muted-foreground">
          Could not load user details.
        </Card>
      </div>
    )
  }

  const u = data.user

  return (
    <div>
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-4 -ml-2">
        <ArrowLeft className="size-4" /> Back to users
      </Button>

      {/* User profile header */}
      <Card className="p-5 mb-6 bg-card/40 border-border/60">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="size-14 rounded-lg bg-gradient-to-br from-primary/30 to-primary/10 border border-primary/20 flex items-center justify-center text-lg font-mono font-semibold text-primary shrink-0">
            {(u.name ?? u.userId).slice(0, 2).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-xl font-semibold truncate">{u.name ?? 'Unnamed user'}</h2>
              <Badge variant="outline" className="font-mono text-[10px] uppercase">
                {u.plan}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
              <span className="truncate">{u.email ?? 'no email'}</span>
              <span className="text-muted-foreground/60">·</span>
              <span>{u.userId}</span>
              <span className="text-muted-foreground/60">·</span>
              <span>created {timeAgo(u.createdAt)}</span>
            </div>
            {data.telegramConfig && (
              <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                <Badge variant="secondary" className="font-mono text-[9px] gap-0.5">
                  <Server className="size-2.5" />
                  {data.telegramConfig.hasCustomBotToken ? 'custom bot' : 'server bot'}
                </Badge>
                <span className="font-mono">chat {data.telegramConfig.chatId}</span>
                {data.telegramConfig.label && (
                  <span className="text-muted-foreground/60">· {data.telegramConfig.label}</span>
                )}
              </div>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>

        {/* Quick stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5 pt-5 border-t border-border/40">
          <QuickStat label="Records" value={data.records.length} />
          <QuickStat label="Collections" value={data.collections.length} />
          <QuickStat label="Files" value={data.files.length} />
          <QuickStat
            label="API Keys"
            value={`${data.apiKeys.filter((k) => !k.revoked).length}/${data.apiKeys.length}`}
          />
        </div>
      </Card>

      {/* Sub-tabs */}
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as typeof subTab)}>
        <TabsList className="mb-4">
          <TabsTrigger value="keyvalues">
            <DbIcon className="size-3.5" /> KeyValues
          </TabsTrigger>
          <TabsTrigger value="collections">
            <Folder className="size-3.5" /> Collections
          </TabsTrigger>
          <TabsTrigger value="files">
            <FileText className="size-3.5" /> Files
          </TabsTrigger>
          <TabsTrigger value="apikeys">
            <KeyRound className="size-3.5" /> API Keys
          </TabsTrigger>
        </TabsList>

        <TabsContent value="keyvalues">
          <KeyValuesTable records={data.records} />
        </TabsContent>
        <TabsContent value="collections">
          <CollectionsTable collections={data.collections} />
        </TabsContent>
        <TabsContent value="files">
          <UserFilesList files={data.files} />
        </TabsContent>
        <TabsContent value="apikeys">
          <ApiKeysTable apiKeys={data.apiKeys} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function QuickStat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
    </div>
  )
}

/* ─── KeyValues sub-tab — database-IDE-style table ────────────────── */

function KeyValuesTable({ records }: { records: AdminRecordView[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  if (records.length === 0) {
    return (
      <Card className="p-10 bg-card/40 border-border/60 text-center">
        <DbIcon className="size-8 mx-auto mb-3 text-muted-foreground/50" />
        <p className="text-sm font-medium">No records</p>
        <p className="text-xs text-muted-foreground mt-1">
          This user hasn't written any key-value data yet.
        </p>
      </Card>
    )
  }

  return (
    <Card className="bg-card/40 border-border/60 overflow-hidden">
      <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-card/95 backdrop-blur-sm">
            <TableRow className="hover:bg-transparent border-border/40">
              <TableHead className="w-[44px] text-center font-mono text-[10px] uppercase tracking-wider text-muted-foreground/50">#</TableHead>
              <TableHead className="w-[36px]" />
              <TableHead className="w-[24%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Key</TableHead>
              <TableHead className="w-[10%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Type</TableHead>
              <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Value</TableHead>
              <TableHead className="w-[12%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden md:table-cell">Collection</TableHead>
              <TableHead className="w-[11%] font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden sm:table-cell">Updated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.map((r, idx) => {
              const isExpanded = expanded.has(r.id)
              const isLong = isLongValue(r.value, r.valueType)
              return (
                <Fragment key={r.id}>
                  <TableRow className="border-border/30 group hover:bg-primary/[0.03]">
                    <TableCell className="text-center font-mono text-[11px] text-muted-foreground/40 tabular-nums py-2.5 select-none">
                      {idx + 1}
                    </TableCell>
                    <TableCell className="py-2.5">
                      {isLong && (
                        <button
                          onClick={() => toggleExpand(r.id)}
                          className="text-muted-foreground hover:text-primary transition-colors"
                          title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? (
                            <ChevronRight className="size-3.5 rotate-90" />
                          ) : (
                            <ChevronRight className="size-3.5" />
                          )}
                        </button>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-foreground/90 py-2.5 font-medium">
                      {r.key}
                    </TableCell>
                    <TableCell className="py-2.5">
                      <TypeBadge type={r.valueType} />
                    </TableCell>
                    <TableCell className="py-2.5 max-w-0">
                      <ValueCell value={r.value} type={r.valueType} expanded={isExpanded} />
                    </TableCell>
                    <TableCell className="hidden md:table-cell py-2.5">
                      {r.collection === 'default' ? (
                        <span className="text-[11px] text-muted-foreground/60 font-mono">default</span>
                      ) : (
                        <Badge variant="outline" className="font-mono text-[10px] border-primary/30 text-primary/80">
                          {r.collection}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-[11px] text-muted-foreground/70 font-mono py-2.5 tabular-nums">
                      {timeAgo(r.updatedAt)}
                    </TableCell>
                  </TableRow>
                  {isExpanded && (
                    <TableRow className="border-border/20 bg-muted/20">
                      <TableCell />
                      <TableCell />
                      <TableCell colSpan={5} className="py-3">
                        <pre className="font-mono text-xs text-foreground/80 whitespace-pre-wrap break-all max-h-72 overflow-y-auto bg-background/60 border border-border/40 rounded-md p-3">
                          {formatExpanded(r.value, r.valueType)}
                        </pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              )
            })}
          </TableBody>
        </Table>
      </div>
      <div className="px-3 py-2 border-t border-border/40 text-[11px] text-muted-foreground/70 font-mono">
        {records.length} record{records.length === 1 ? '' : 's'}
      </div>
    </Card>
  )
}

function isLongValue(value: unknown, type: string): boolean {
  if (type === 'string') return String(value).length > 80
  if (type === 'object' || type === 'array') return JSON.stringify(value).length > 80
  return false
}

function ValueCell({ value, type, expanded }: { value: unknown; type: string; expanded: boolean }) {
  if (type === 'string') {
    const s = String(value)
    const display = expanded || s.length <= 80 ? s : s.slice(0, 80) + '…'
    return <span className="font-mono text-sm text-foreground/90">{display}</span>
  }
  if (type === 'boolean') {
    return <span className="font-mono text-sm text-amber-700">{String(value)}</span>
  }
  if (type === 'number') {
    return <span className="font-mono text-sm text-sky-700">{String(value)}</span>
  }
  const json = JSON.stringify(value)
  const display = expanded || json.length <= 80 ? json : json.slice(0, 80) + '…'
  return <span className="font-mono text-sm text-violet-700/90">{display}</span>
}

function formatExpanded(value: unknown, type: string): string {
  if (type === 'object' || type === 'array') return JSON.stringify(value, null, 2)
  return String(value)
}

/* ─── Collections sub-tab ─────────────────────────────────────────── */

function CollectionsTable({ collections }: { collections: AdminCollectionView[] }) {
  if (collections.length === 0) {
    return (
      <Card className="p-10 bg-card/40 border-border/60 text-center">
        <Folder className="size-8 mx-auto mb-3 text-muted-foreground/50" />
        <p className="text-sm font-medium">No collections</p>
        <p className="text-xs text-muted-foreground mt-1">This user has no named collections yet.</p>
      </Card>
    )
  }

  return (
    <Card className="bg-card/40 border-border/60 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-border/40">
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Collection</TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right">Records</TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden sm:table-cell">Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {collections.map((c) => (
            <TableRow key={c.name} className="border-border/30 hover:bg-primary/[0.03]">
              <TableCell className="py-2.5">
                {c.name === 'default' ? (
                  <span className="font-mono text-sm text-muted-foreground/80">default</span>
                ) : (
                  <Badge variant="outline" className="font-mono text-[11px] border-primary/30 text-primary/80">
                    {c.name}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="py-2.5 text-right font-mono text-sm tabular-nums">{c.count}</TableCell>
              <TableCell className="py-2.5 hidden sm:table-cell text-[11px] text-muted-foreground/70 font-mono">
                {timeAgo(c.createdAt)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

/* ─── Files sub-tab (within UserDetail) ───────────────────────────── */

function UserFilesList({ files }: { files: AdminUserFile[] }) {
  if (files.length === 0) {
    return (
      <Card className="p-10 bg-card/40 border-border/60 text-center">
        <FileText className="size-8 mx-auto mb-3 text-muted-foreground/50" />
        <p className="text-sm font-medium">No files</p>
        <p className="text-xs text-muted-foreground mt-1">This user hasn't uploaded any files yet.</p>
      </Card>
    )
  }

  return (
    <div className="space-y-2">
      {files.map((f) => (
        <AdminFileRow key={f.id} file={f} showOwner={false} />
      ))}
    </div>
  )
}

/* ─── API Keys sub-tab ────────────────────────────────────────────── */

function ApiKeysTable({ apiKeys }: { apiKeys: AdminApiKeyView[] }) {
  if (apiKeys.length === 0) {
    return (
      <Card className="p-10 bg-card/40 border-border/60 text-center">
        <KeyRound className="size-8 mx-auto mb-3 text-muted-foreground/50" />
        <p className="text-sm font-medium">No API keys</p>
        <p className="text-xs text-muted-foreground mt-1">This user has no API keys yet.</p>
      </Card>
    )
  }

  return (
    <Card className="bg-card/40 border-border/60 overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent border-border/40">
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Name</TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70">Key prefix</TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden sm:table-cell">Created</TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 hidden sm:table-cell">Last used</TableHead>
            <TableHead className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground/70 text-right">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {apiKeys.map((k) => (
            <TableRow key={k.id} className="border-border/30 hover:bg-primary/[0.03]">
              <TableCell className="py-2.5 text-sm font-medium">{k.name}</TableCell>
              <TableCell className="py-2.5">
                <code className="font-mono text-xs text-muted-foreground">{k.keyPrefix}</code>
              </TableCell>
              <TableCell className="py-2.5 hidden sm:table-cell text-[11px] text-muted-foreground/70 font-mono">
                {timeAgo(k.createdAt)}
              </TableCell>
              <TableCell className="py-2.5 hidden sm:table-cell text-[11px] text-muted-foreground/70 font-mono">
                {k.lastUsedAt ? timeAgo(k.lastUsedAt) : 'never'}
              </TableCell>
              <TableCell className="py-2.5 text-right">
                {k.revoked ? (
                  <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/30 font-mono text-[10px]">
                    revoked
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 font-mono text-[10px]">
                    active
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  )
}

/* ===================================================================
 *  All Files tab — list ALL files across ALL users.
 * =================================================================== */

interface AllFilesResponse {
  files: AdminFileSummary[]
  stats: GlobalStats
}

function AllFilesView() {
  const api = useApi()
  const [search, setSearch] = useState('')

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'files'],
    queryFn: () => api<AllFilesResponse>('/api/admin/files'),
  })

  const files = useMemo(() => {
    const list = data?.files ?? []
    if (!search.trim()) return list
    const q = search.toLowerCase()
    return list.filter(
      (f) =>
        f.fileName.toLowerCase().includes(q) ||
        f.mimeType.toLowerCase().includes(q) ||
        (f.label ?? '').toLowerCase().includes(q) ||
        (f.owner.email ?? '').toLowerCase().includes(q) ||
        (f.owner.name ?? '').toLowerCase().includes(q) ||
        f.owner.userId.toLowerCase().includes(q),
    )
  }, [data, search])

  return (
    <div>
      <PageHeader
        title="All Files"
        description="Every file across every user. Tap “Get link” to mint a 1-hour Telegram download URL for any file (cross-user admin override)."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} title="Refresh">
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
          </Button>
        }
      />

      <div className="mb-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="p-3 bg-card/40 border-border/60">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">Total files</div>
          <div className="text-xl font-semibold tabular-nums">{data?.stats.files ?? '—'}</div>
        </Card>
        <Card className="p-3 bg-card/40 border-border/60">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">Total size</div>
          <div className="text-xl font-semibold tabular-nums">{formatBytes(data?.stats.fileBytes ?? 0)}</div>
        </Card>
        <Card className="p-3 bg-card/40 border-border/60">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">Public</div>
          <div className="text-xl font-semibold tabular-nums">
            {files.filter((f) => f.isPublic).length}
          </div>
        </Card>
        <Card className="p-3 bg-card/40 border-border/60">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 font-mono">Private</div>
          <div className="text-xl font-semibold tabular-nums">
            {files.filter((f) => !f.isPublic).length}
          </div>
        </Card>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by filename, mime, label, or owner…"
          className="pl-9 h-9"
        />
      </div>

      {isLoading ? (
        <Card className="p-16 bg-card/40 border-border/60 grid place-items-center">
          <Loader2 className="size-5 animate-spin text-primary" />
        </Card>
      ) : files.length === 0 ? (
        <Card className="p-10 bg-card/40 border-border/60 text-center">
          <FileText className="size-8 mx-auto mb-3 text-muted-foreground/50" />
          <p className="text-sm font-medium">{search ? 'No matches' : 'No files'}</p>
        </Card>
      ) : (
        <div className="space-y-2">
          {files.map((f) => (
            <AdminFileRow key={f.id} file={f} showOwner />
          ))}
        </div>
      )}

      <div className="mt-3 text-xs text-muted-foreground/70 font-mono">
        {files.length} file{files.length === 1 ? '' : 's'}
        {search && ` · filtered from ${data?.files.length ?? 0}`}
      </div>
    </div>
  )
}

/* ===================================================================
 *  AdminFileRow — one file row, with on-demand Telegram link.
 *  Handles the localStorage link cache (55-min TTL) inline.
 * =================================================================== */

type LinkStatus =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'revoking' }
  | { status: 'ready'; url: string; expiresAt: number }
  | { status: 'error'; message: string }

function AdminFileRow({
  file,
  showOwner,
}: {
  file: AdminFileSummary | AdminUserFile
  showOwner: boolean
}) {
  const api = useApi()
  const qc = useQueryClient()
  const [state, setState] = useState<LinkStatus>(() => {
    const cached = loadCachedLink(file.id)
    return cached ? { status: 'ready', url: cached.url, expiresAt: cached.expiresAt } : { status: 'idle' }
  })
  const [secondsLeft, setSecondsLeft] = useState(0)
  const [copied, setCopied] = useState(false)

  // Live countdown ticker when a link is ready.
  useEffect(() => {
    if (state.status !== 'ready') return
    const tick = () => {
      const remaining = Math.max(0, Math.floor((state.expiresAt - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) {
        clearCachedLink(file.id)
        setState({ status: 'idle' })
      }
    }
    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [state, file.id])

  const fetchLink = useCallback(
    async (force: boolean) => {
      setState({ status: 'loading' })
      setCopied(false)
      try {
        const path = `/api/admin/files/${file.id}/link${force ? '?force=1' : ''}`
        const res = await api<{
          url: string
          expiresAt: number
          expiresInSec: number
          revocable: boolean
          file: { fileName: string }
        }>(path, { method: 'POST' })
        const expiresAt = res.expiresAt || Date.now() + LINK_TTL_MS
        saveCachedLink(file.id, res.url, expiresAt)
        setState({ status: 'ready', url: res.url, expiresAt })
        setSecondsLeft(Math.max(0, res.expiresInSec))
        toast.success('Telegram link ready — valid for ~1 hour')
      } catch (err) {
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not fetch link from Telegram.',
        })
      }
    },
    [api, file.id],
  )

  const revokeLink = useCallback(async () => {
    setState({ status: 'revoking' })
    try {
      await api<{ revoked: boolean }>(`/api/admin/files/${file.id}/link`, { method: 'DELETE' })
      clearCachedLink(file.id)
      setState({ status: 'idle' })
      toast.success('Link revoked — cached URL dropped.')
      qc.invalidateQueries({ queryKey: ['admin', 'files'] })
    } catch (err) {
      setState({
        status: 'error',
        message: err instanceof Error ? err.message : 'Could not revoke link.',
      })
    }
  }, [api, file.id, qc])

  const copyLink = useCallback(async () => {
    if (state.status !== 'ready') return
    try {
      await navigator.clipboard.writeText(state.url)
      setCopied(true)
      toast.success('Link copied')
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }, [state])

  const fileName = file.fileName
  const owner = 'owner' in file ? file.owner : null

  return (
    <Card className="bg-card/40 border-border/60 p-3.5">
      <div className="flex items-start gap-3">
        <div className="size-9 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
          <FileIcon className="size-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm truncate text-foreground/90">{fileName}</span>
            {file.isPublic ? (
              <Unlock className="size-3 text-muted-foreground shrink-0" />
            ) : (
              <Lock className="size-3 text-muted-foreground shrink-0" />
            )}
            {file.storageMode === 'custom' ? (
              <Badge variant="outline" className="font-mono text-[9px] px-1 py-0 shrink-0">
                custom
              </Badge>
            ) : (
              <Badge variant="secondary" className="font-mono text-[9px] px-1 py-0 shrink-0 gap-0.5">
                <Server className="size-2.5" /> server
              </Badge>
            )}
            {file.label && (
              <Badge variant="outline" className="font-mono text-[9px] px-1 py-0 shrink-0">
                {file.label}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground mt-0.5 flex-wrap">
            <span className="tabular-nums">{formatBytes(file.size)}</span>
            <span>·</span>
            <span className="truncate">{file.mimeType || 'unknown'}</span>
            <span>·</span>
            <span>{timeAgo(file.createdAt)}</span>
            <span>·</span>
            <span className="tabular-nums">{file.downloads} dl</span>
            {owner && showOwner && (
              <>
                <span>·</span>
                <span className="truncate">
                  owned by{' '}
                  <span className="text-foreground/80">{owner.name ?? owner.email ?? owner.userId}</span>
                </span>
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {state.status === 'idle' && (
            <Button size="sm" onClick={() => fetchLink(false)} className="h-8 bg-primary hover:bg-primary/90 text-primary-foreground">
              <Link2 className="size-3.5" /> Get link
            </Button>
          )}
          {state.status === 'loading' && (
            <Button size="sm" disabled className="h-8">
              <Loader2 className="size-3.5 animate-spin" /> Minting…
            </Button>
          )}
          {state.status === 'revoking' && (
            <Button size="sm" disabled className="h-8">
              <Loader2 className="size-3.5 animate-spin" /> Revoking…
            </Button>
          )}
          {(state.status === 'ready' || state.status === 'error') && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => fetchLink(false)}
              className="h-8"
              title="Refresh"
            >
              <RefreshCw className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Inline link display */}
      {state.status === 'error' && (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-red-300/50 bg-red-50 p-2.5 text-xs text-red-700">
          <AlertCircle className="size-3.5 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p>{state.message}</p>
            <button
              onClick={() => fetchLink(true)}
              className="mt-1 underline text-[11px] hover:text-red-800"
            >
              Try again with force-refresh
            </button>
          </div>
        </div>
      )}

      {state.status === 'ready' && (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <Input readOnly value={state.url} className="font-mono text-xs h-9" onFocus={(e) => e.currentTarget.select()} />
            <Button
              size="sm"
              variant="outline"
              onClick={copyLink}
              className="h-9 px-3 shrink-0"
              title="Copy link"
            >
              {copied ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
            </Button>
            <a href={state.url} target="_blank" rel="noreferrer" className="shrink-0">
              <Button size="sm" variant="outline" className="h-9 px-3" title="Open in new tab">
                <ExternalLink className="size-3.5" />
              </Button>
            </a>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-mono',
                secondsLeft > 0
                  ? 'border-primary/30 bg-primary/5 text-foreground/80'
                  : 'border-red-300/50 bg-red-50 text-red-700',
              )}
            >
              {secondsLeft > 0 ? (
                <>
                  <Timer className="size-3 text-primary" />
                  <span>valid for {formatCountdown(secondsLeft)}</span>
                </>
              ) : (
                <>
                  <Clock className="size-3" />
                  <span>expired — refresh for a new one</span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => fetchLink(true)}
                className="h-7 text-[11px]"
                title="Force-refresh from Telegram (busts cache)"
              >
                <RefreshCw className="size-3 mr-1" /> Refresh
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={revokeLink}
                className="h-7 text-[11px] text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                title="Drop the cached URL from the server"
              >
                <Trash2 className="size-3 mr-1" /> Revoke
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

/* ===================================================================
 *  Admins tab — promote users + list/revoke admin keys.
 * =================================================================== */

function AdminsView() {
  const api = useApi()
  const qc = useQueryClient()
  const [kvLiveKey, setKvLiveKey] = useState('')
  const [label, setLabel] = useState('')
  const [promotedResult, setPromotedResult] = useState<{
    adminKey: string
    label: string
    message: string
  } | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<AdminKeyView | null>(null)
  const [copiedNewKey, setCopiedNewKey] = useState(false)

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['admin', 'admins'],
    queryFn: () => api<{ admins: AdminKeyView[] }>('/api/admin/admins'),
  })

  const promoteMutation = useMutation({
    mutationFn: (opts: { kvLiveKey: string; label: string }) =>
      api<{ adminKey: string; label: string; createdAt: string; message: string }>(
        '/api/admin/promote',
        {
          method: 'POST',
          body: JSON.stringify({ kvLiveKey: opts.kvLiveKey, label: opts.label }),
        },
      ),
    onSuccess: (res) => {
      toast.success('User promoted to admin')
      setPromotedResult({ adminKey: res.adminKey, label: res.label, message: res.message })
      setKvLiveKey('')
      setLabel('')
      qc.invalidateQueries({ queryKey: ['admin', 'admins'] })
      qc.invalidateQueries({ queryKey: ['admin', 'stats'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const revokeMutation = useMutation({
    mutationFn: (id: string) =>
      api<{ revoked: boolean }>(`/api/admin/admins?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Admin key revoked')
      setRevokeTarget(null)
      qc.invalidateQueries({ queryKey: ['admin', 'admins'] })
      qc.invalidateQueries({ queryKey: ['admin', 'stats'] })
    },
    onError: (err: Error) => toast.error(err.message),
  })

  const admins = data?.admins ?? []

  async function copyNewKey() {
    if (!promotedResult) return
    try {
      await navigator.clipboard.writeText(promotedResult.adminKey)
      setCopiedNewKey(true)
      toast.success('Admin key copied')
      setTimeout(() => setCopiedNewKey(false), 1800)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  return (
    <div>
      <PageHeader
        title="Admins"
        description="Promote a developer to admin by their kv_live API key, or revoke an existing admin's access. Bootstrap key cannot be revoked."
        actions={
          <Button variant="outline" size="sm" onClick={() => refetch()} title="Refresh">
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
          </Button>
        }
      />

      <div className="grid lg:grid-cols-[1fr_1.4fr] gap-6">
        {/* Promote form */}
        <Card className="p-5 bg-card/40 border-border/60 h-fit">
          <div className="flex items-center gap-2 mb-1">
            <Plus className="size-4 text-primary" />
            <h3 className="text-sm font-semibold">Promote a user to admin</h3>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Enter the developer's <code className="font-mono">kv_live_…</code> API key. We'll mint a new{' '}
            <code className="font-mono">onyxbase_…</code> key that grants full admin access.
          </p>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="kv-key" className="text-xs">kv_live API key</Label>
              <Input
                id="kv-key"
                value={kvLiveKey}
                onChange={(e) => setKvLiveKey(e.target.value)}
                placeholder="kv_live_a1b2c3d4…"
                className="font-mono text-xs h-9"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="label" className="text-xs">Label (optional)</Label>
              <Input
                id="label"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. On-call engineer"
                className="h-9"
              />
            </div>
            <Button
              className="w-full bg-primary hover:bg-primary/90 text-primary-foreground"
              onClick={() => promoteMutation.mutate({ kvLiveKey: kvLiveKey.trim(), label: label.trim() })}
              disabled={!kvLiveKey.trim().startsWith('kv_live_') || promoteMutation.isPending}
            >
              {promoteMutation.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ShieldCheck className="size-4" />
              )}
              Promote to admin
            </Button>
            {kvLiveKey && !kvLiveKey.startsWith('kv_live_') && (
              <p className="text-[11px] text-amber-600">Key must start with <code className="font-mono">kv_live_</code>.</p>
            )}
          </div>
        </Card>

        {/* Admin keys list */}
        <Card className="bg-card/40 border-border/60 overflow-hidden">
          <div className="px-4 py-3 border-b border-border/40 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Admin keys</h3>
            <span className="text-[11px] text-muted-foreground font-mono">{admins.length} total</span>
          </div>
          {isLoading ? (
            <div className="py-12 grid place-items-center">
              <Loader2 className="size-5 animate-spin text-primary" />
            </div>
          ) : (
            <div className="divide-y divide-border/30">
              {admins.map((k) => (
                <div key={k.id} className="p-4 flex items-start gap-3 hover:bg-muted/30 transition-colors">
                  <div className="size-9 rounded-md bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
                    {k.revoked ? (
                      <ShieldAlert className="size-4 text-red-500" />
                    ) : (
                      <ShieldCheck className="size-4 text-red-600" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{k.label}</span>
                      {k.isBootstrap && (
                        <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 hover:bg-amber-500/15 font-mono text-[10px] uppercase">
                          bootstrap
                        </Badge>
                      )}
                      {k.revoked ? (
                        <Badge variant="outline" className="bg-red-500/10 text-red-600 border-red-500/30 font-mono text-[10px]">
                          revoked
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-600 border-emerald-500/30 font-mono text-[10px]">
                          active
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground font-mono">
                      <code className="text-muted-foreground/80">{maskKey(k.key)}</code>
                      <span>·</span>
                      <span>created {timeAgo(k.createdAt)}</span>
                      <span>·</span>
                      <span>
                        {k.createdBy === 'bootstrap'
                          ? 'seeded at boot'
                          : k.promotedFromUserEmail
                            ? `from ${k.promotedFromUserEmail}`
                            : 'promoted'}
                      </span>
                    </div>
                  </div>
                  <div className="shrink-0">
                    {!k.isBootstrap && !k.revoked && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRevokeTarget(k)}
                        className="h-8 text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                      >
                        <Trash2 className="size-3.5" /> Revoke
                      </Button>
                    )}
                    {k.isBootstrap && (
                      <span className="text-[11px] text-muted-foreground italic">cannot revoke</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Promote success dialog — show the new key */}
      <Dialog open={!!promotedResult} onOpenChange={(o) => !o && setPromotedResult(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-primary" /> Admin key created
            </DialogTitle>
            <DialogDescription>
              Share this key with the promoted user. They can sign in to the admin dashboard with it.
            </DialogDescription>
          </DialogHeader>
          {promotedResult && (
            <div className="space-y-3">
              <div className="flex items-start gap-2 rounded-md border border-amber-300/50 bg-amber-50 p-3 text-xs text-amber-800">
                <AlertCircle className="size-4 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">This key grants FULL admin access.</p>
                  <p className="mt-0.5">
                    Anyone with this key can list all users, read all data, mint download links for any
                    file, and promote or revoke other admins. Store it like a password.
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">New admin key</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={promotedResult.adminKey}
                    className="font-mono text-xs h-9"
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={copyNewKey}
                    className="h-9 px-3 shrink-0"
                  >
                    {copiedNewKey ? <Check className="size-3.5 text-green-600" /> : <Copy className="size-3.5" />}
                  </Button>
                </div>
              </div>
              <div className="text-[11px] text-muted-foreground">
                <Info className="inline size-3 mr-1 align-text-bottom" />
                {promotedResult.message}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setPromotedResult(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke confirm */}
      <AlertDialog open={!!revokeTarget} onOpenChange={(o) => !o && setRevokeTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this admin key?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-medium">{revokeTarget?.label}</span> (
              <code className="font-mono">{revokeTarget && maskKey(revokeTarget.key)}</code>) will lose
              admin access immediately. They can still use their original <code className="font-mono">kv_live_</code> key
              as a regular developer. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revokeMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => revokeTarget && revokeMutation.mutate(revokeTarget.id)}
              disabled={revokeMutation.isPending}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {revokeMutation.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
              Revoke admin key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

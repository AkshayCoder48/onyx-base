# Task 14 — Admin Dashboard Frontend

Agent: full-stack-developer
Scope: Build the admin dashboard UI on top of the existing admin backend (Task 13).

## Files modified / created

- `src/lib/store.ts` — added `useAdminMode: boolean` + `setAdminMode()` to the zustand store. Default `true`, persisted. `setSession()` auto-enables admin mode when the user is an admin; `clearSession()` resets it to `true`.
- `src/components/auth-gate.tsx` — updated the bootstrap to capture `res.isAdmin` from `/api/auth/whoami` and persist it onto `SessionUser`. Now renders `<AdminDashboard />` when `user.isAdmin && useAdminMode`, else `<DashboardShell />` (unchanged for regular users).
- `src/components/admin/admin-dashboard.tsx` — NEW. The full admin UI (~1100 lines) with:
  - **Header bar**: logo + "ADMIN" badge (red), global stat pills (users / records / files / collections / api keys, refreshed every 30s), "Regular dashboard" toggle button, sign-out button. Mobile: stat pills wrap into a horizontal scroll strip.
  - **Tab nav**: Users / All Files / Admins (sticky, horizontally scrollable on mobile).
  - **Users tab**: searchable table of all users (Name, Email, UserID, Records, Colls, Files, API Keys, Created). Click a row → opens `UserDetail`.
  - **UserDetail**: back button, profile header (avatar, name, plan, email, userId, telegram config + bot mode), quick-stats strip, then 4 sub-tabs (KeyValues / Collections / Files / API Keys). The KeyValues sub-tab reuses the database-IDE style from `dashboard/database.tsx` (row numbers, monospace, expandable JSON cells, sticky header, max-height scroll).
  - **All Files tab**: stats strip (total/size/public/private), search, list of every file across all users with owner attribution. Each row has the "Get link" + inline link display.
  - **Admins tab**: promote form (kv_live key + optional label → POST `/api/admin/promote` → success dialog with new `onyxbase_` key + copy button + warning) and admin keys list (bootstrap badge for the seeded key, revoke button for non-bootstrap keys via `DELETE /api/admin/admins?id=`).
  - **Telegram link cache (CRITICAL)**: per-file state machine that caches the URL in `localStorage` under `onyx_admin_link_<fileId>` with a 55-min TTL. On mount, sweeps ALL `onyx_admin_link_*` keys and purges expired ones. Cached URLs render inline (read-only input + Copy + Open + countdown MM:SS + Refresh + Revoke) WITHOUT an API call. When expired, the cache entry is auto-deleted and the "Get link" button returns. Refresh = `?force=1` POST. Revoke = `DELETE /api/admin/files/[id]/link` + clear cache.
- `src/app/admin/page.tsx` — NEW. Direct `/admin` route. Bootstraps the session like AuthGate, then enforces admin access: no session → LoginScreen; admin → AdminDashboard; regular user → "Unauthorized — admin key required" screen with a link back to `/`.

## Constraints respected

- Regular user flow untouched — non-admins always see `<DashboardShell />`.
- Backend untouched — no edits to `data-store.ts`, `auth.ts`, or any API route.
- Uses `useApi()` hook, TanStack Query (`useQuery` / `useMutation`), shadcn/ui (Card / Button / Input / Badge / Dialog / AlertDialog / Table / Tabs / Label), Lucide icons, `formatBytes` / `timeAgo` / `maskKey` / `TypeBadge` from `dashboard/shared.tsx`, `toast` from sonner. Primary color stays orange (`bg-primary` / `text-primary`).
- Responsive (mobile-first): mobile drawer not needed (top-tab layout), tables collapse optional columns on small screens, stat pills wrap to a horizontal scroll on mobile.

## Verification

- `bun run lint` → 0 errors, 3 warnings (all pre-existing unused-eslint-disable patterns).
- `curl http://localhost:3000/admin` → HTTP 200, page compiles in ~1.2s and renders the AuthGate bootstrap spinner (then resolves to AdminDashboard / LoginScreen / UnauthorizedScreen based on session).
- `curl http://localhost:3000/` → HTTP 200, existing regular-user flow unchanged.
- Dev server log: clean, no compile errors after the new files were added.

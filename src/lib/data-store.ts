/**
 * Onyx Base — Telegram-only in-memory store with JSON cache.
 *
 * This replaces the previous Prisma/SQLite layer. Telegram is the durable
 * backup (every write is mirrored as a structured message). A flat JSON file
 * (`db/cloudkv.json`) is used as a local cache so the index survives process
 * restarts — it mirrors exactly what's in Telegram and contains no data that
 * isn't also in the channel.
 *
 * Data model (mirrors the old Prisma schema):
 *   - User       { id, userId, name, email, plan, createdAt, updatedAt }
 *   - ApiKey     { id, key, name, userId, createdAt, lastUsedAt, revoked }
 *   - Record     { id, userId, collection, key, value, valueType, telegramMessageId, createdAt, updatedAt }
 *   - Log        { id, userId, action, key, detail, source, ip, createdAt }
 *
 * Collections are derived (distinct collection names per user from records).
 */

import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {
  sendKvMessage,
  editKvMessage,
  deleteKvMessage,
  sendAndPinManifest,
  sendAndPinFullState,
  fetchPinnedManifest,
  sendDocumentFile,
  deleteFileMessage,
  CLOUD_UPLOAD_LIMIT_BYTES,
  LOCAL_BOT_API_LIMIT_BYTES,
  type TelegramPayload,
  type SentDocument,
  // V4 per-account manifest transport
  fetchAccountIndex,
  pinAccountIndex,
  sendAccountManifest,
  fetchAccountManifest,
  SYSTEM_ACCOUNT_ID,
  type AccountIndex,
  type AccountIndexEntry,
  type AccountManifest,
} from '@/lib/telegram'
import { hashPassword, verifyPassword } from '@/lib/password'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UserRecord {
  id: string
  userId: string
  name: string | null
  email: string | null
  /**
   * Scrypt password hash (format: `scrypt$<saltHex>$<hashHex>`).
   * Set when the user signs up with a password. Optional because legacy /
   * CLI-created accounts may not have one — those accounts can only be
   * accessed via their API key. The hash is mirrored to the Telegram
   * identity manifest alongside the rest of the user record so it survives
   * full local-store wipes.
   */
  passwordHash: string | null
  plan: string
  createdAt: string
  updatedAt: string
}

/**
 * Fine-grained scopes an API key can carry.
 *
 * - `read`        → GET /v1/get, /v1/list, /v1/stats, /v1/logs, /v1/health, /v1/whoami
 * - `write`       → POST /v1/set + any create/update mutation on records
 * - `delete`      → DELETE /v1/delete, record deletion
 * - `files`       → /v1/files/* (upload, list, download, delete, link, revoke)
 * - `tables`      → /v1/tables/* (schema + row CRUD)
 * - `collections` → /v1/collections/* (list/create/delete)
 * - `export`      → /v1/export
 *
 * An EMPTY scopes array = full access (backward compatibility for keys
 * minted before scopes existed). This keeps every existing key working
 * unchanged after the v3 manifest upgrade.
 */
export type ApiKeyScope =
  | 'read'
  | 'write'
  | 'delete'
  | 'files'
  | 'tables'
  | 'collections'
  | 'export'

export const ALL_API_KEY_SCOPES: ApiKeyScope[] = [
  'read',
  'write',
  'delete',
  'files',
  'tables',
  'collections',
  'export',
]

export interface ApiKeyRecord {
  id: string
  key: string
  name: string
  userId: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
  /** v3: scopes granted to this key. Empty = full access (backward compat). */
  scopes: ApiKeyScope[]
  /** v3: ISO timestamp; null = never expires. */
  expiresAt: string | null
  /** v3: when non-empty, only these collections are accessible. Empty = all. */
  collectionAllowList: string[]
  /** v3: when non-empty, only these tables are accessible. Empty = all. */
  tableAllowList: string[]
  /** v3: max requests per minute. null/0 = unlimited. */
  rateLimitPerMin: number | null
  /** v3: max megabytes written per UTC day. null/0 = unlimited. */
  rateLimitMbPerDay: number | null
}

/** Options accepted by createApiKey / updateApiKey. */
export interface ApiKeyOpts {
  scopes?: ApiKeyScope[]
  expiresAt?: string | null
  collectionAllowList?: string[]
  tableAllowList?: string[]
  rateLimitPerMin?: number | null
  rateLimitMbPerDay?: number | null
}

export interface RecordEntry {
  id: string
  userId: string
  collection: string
  key: string
  value: string
  valueType: string
  telegramMessageId: number | null
  createdAt: string
  updatedAt: string
}

export interface LogEntry {
  id: string
  userId: string
  action: string
  key: string | null
  detail: string | null
  source: string
  ip: string | null
  createdAt: string
}

interface TelegramConfigRecord {
  /** The dbUserId this config belongs to. */
  userId: string
  /** Custom Telegram chat ID (e.g. -1001234567890) — overrides the env default. */
  chatId: string
  /** Optional label for the user's own reference (e.g. "My channel"). */
  label: string | null
  /** Optional custom bot token — overrides the env default for this user's writes. */
  botToken: string | null
  /** Whether the bot token was set by the user (for display; the token itself is never returned to the client). */
  hasCustomBotToken: boolean
  /**
   * Optional custom local Bot API server URL (e.g. `http://localhost:8081`).
   * When set, ALL Telegram API calls for this user route through this server
   * instead of the cloud api.telegram.org. This unlocks 2 GB uploads/downloads
   * (the cloud API caps at 50 MB upload / 20 MB download).
   * See: https://github.com/tdlib/telegram-bot-api
   */
  botApiBaseUrl: string | null
  updatedAt: string
}

/**
 * Public share token — a scoped, revocable, rate-limited credential that is
 * SAFE to embed in public HTML (CodePen, static sites, etc.).
 *
 * Unlike a master API key (which grants full read/write/delete on every key),
 * a share token is bound to ONE (collection, key) pair and a single mode.
 * Leaking it only exposes that one value; the owner can revoke/rotate anytime.
 */
export interface ShareTokenRecord {
  id: string
  /** The public token string, e.g. `st_a1b2c3...`. Safe to put in HTML. */
  token: string
  /** Owner's dbUserId. */
  userId: string
  collection: string
  key: string
  /** read | write | readwrite — what the public token can do. */
  mode: 'read' | 'write' | 'readwrite'
  /** Optional human label for the dashboard list. */
  label: string | null
  /** ISO timestamp; null = never expires. */
  expiresAt: string | null
  /** Max requests per minute per IP; null = unlimited. */
  rateLimitPerMin: number | null
  /** For write tokens: which ops are permitted. */
  allowedOps: ('set' | 'incr' | 'append')[]
  /** For write tokens: max length of a `set` value (bytes). null = no limit. */
  maxValueLength: number | null
  /** For `incr`: clamp the resulting counter to [incrMin, incrMax]. null = unbounded. */
  incrMin: number | null
  incrMax: number | null
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}

export interface FileRecord {
  id: string
  /** Public, unguessable id used in the permanent download link, e.g. `f_a1b2c3...`. */
  fileId: string
  /** Owner's dbUserId. */
  userId: string
  /** Original filename (sanitised). ALL extensions accepted — exe, txt, png, jpg, anything. */
  fileName: string
  /** Detected / declared MIME type. */
  mimeType: string
  /** Size in bytes (as reported by the uploader). */
  size: number
  /** Telegram message id holding the document (for deletion). */
  telegramMessageId: number | null
  /** Stable Telegram file_id — used by getFile to resolve a fresh download URL. */
  telegramFileId: string
  /** Telegram file_unique_id (stable across bots). */
  telegramFileUniqueId: string
  /**
   * Which Telegram backend the file was uploaded to.
   * - `'server'` → the operator's env-configured bot (TELEGRAM_BOT_TOKEN +
   *   TELEGRAM_CHAT_ID). Used AUTOMATICALLY when the user has no full custom
   *   config. This is the "server-sided telegram storage automatically when
   *   custom not set up" default.
   * - `'custom'` → the user's own bot + chat (set via Settings). Used only
   *   when the user has provided BOTH a custom chatId AND a custom botToken.
   *
   * A Telegram file_id is bot-specific, so the download proxy MUST use the
   * same bot that uploaded the file — even if the user later changes their
   * custom config. `storageMode` is what lets us resolve the right bot.
   */
  storageMode: 'server' | 'custom'
  /**
   * The Bot API base URL used at upload time. `null`/empty = cloud api.telegram.org.
   * A non-empty URL (e.g. `http://localhost:8081`) means the file was uploaded
   * via a local Bot API server — its `telegramFileId` is LOCAL and can ONLY be
   * resolved by the same local server + the same bot token. We store this on
   * the file record so the download proxy knows which backend to call, even if
   * the user later removes or changes their custom server config.
   */
  botApiBaseUrl: string | null
  /** Optional human label. */
  label: string | null
  /** Whether the permanent link works without authentication. Default true. */
  isPublic: boolean
  /** Download counter (incremented on each proxy download). */
  downloads: number
  /**
   * Epoch-ms of the most recent "Revoke link" action. When set, the cached
   * Telegram URL has been explicitly invalidated server-side; the next
   * "Get link" call will mint a BRAND-NEW URL from Telegram (the previous URL
   * remains valid for Telegram's natural ~1-hour expiry, which we cannot
   * shorten — but we no longer serve or cache it).
   */
  linkRevokedAt: number | null
  createdAt: string
  updatedAt: string
}

interface StoreShape {
  users: UserRecord[]
  apiKeys: ApiKeyRecord[]
  records: RecordEntry[]
  logs: LogEntry[]
  telegramConfigs: TelegramConfigRecord[]
  shareTokens: ShareTokenRecord[]
  files: FileRecord[]
  /**
   * Explicitly-named collections created via the dashboard / API. Collections
   * are ALSO implicitly derived from records — but without this list, an
   * empty collection (just created, no records yet) would be invisible in
   * the UI. Each entry is `{ userId, name, createdAt }`.
   */
  collectionNames: CollectionNameRecord[]
  /** Admin keys (`onyxbase_*`) — grant cross-user read access via /admin. */
  adminKeys: AdminKeyRecord[]
}

interface CollectionNameRecord {
  userId: string
  name: string
  createdAt: string
}

// ─── Admin keys ──────────────────────────────────────────────────────────────

/**
 * Admin keys grant cross-user read access to ALL data in the system — every
 * user's collections, records, files, and API keys. They are used by the
 * `/admin` dashboard, which is a separate app surface only reachable with an
 * `onyxbase_*` key.
 *
 * The bootstrap key (the value of `process.env.BOOTSTRAP_ADMIN_KEY`, set by
 * the operator in `.env`) cannot be revoked.
 * Additional admins are created by "promoting" a regular user (via their
 * `kv_live_*` key) — this mints a new `onyxbase_<hex>` key for them.
 *
 * Admin keys ALSO work as a regular Bearer token on /v1/* and /api/* routes —
 * they map to a virtual admin user (id `admin`, userId `usr_admin`) so the
 * admin can use the basic storage app too.
 */
export interface AdminKeyRecord {
  id: string
  /** The full key string, e.g. `onyxbase_<hex>` (the bootstrap value comes from BOOTSTRAP_ADMIN_KEY env). */
  key: string
  /** Human-readable label (e.g. "Bootstrap Admin", "Promoted from alice@…"). */
  label: string
  createdAt: string
  /** Who created this key: `'bootstrap'` or the id of the promoting admin key. */
  createdBy: string
  /** The dbUserId this admin was promoted from (null for bootstrap). */
  promotedFromUserId: string | null
  /** The email of the user this admin was promoted from (for display). */
  promotedFromUserEmail: string | null
  revoked: boolean
}

/**
 * The bootstrap admin key — always works, cannot be revoked.
 *
 * SECURITY: Loaded from `process.env.BOOTSTRAP_ADMIN_KEY` so the production key
 * is NEVER committed to source control. Operators set it in `.env` (which is
 * gitignored). The legacy hard-coded value is gone — if the env var is missing
 * we surface that loudly at boot instead of silently using a leaked default.
 */
export const BOOTSTRAP_ADMIN_KEY = process.env.BOOTSTRAP_ADMIN_KEY || ''

/** True when an operator has configured the bootstrap admin key. */
export const BOOTSTRAP_ADMIN_KEY_CONFIGURED = BOOTSTRAP_ADMIN_KEY.length > 0

/** The virtual admin user's dbUserId (admin can use the regular app too). */
export const ADMIN_DB_USER_ID = 'admin'
export const ADMIN_PUBLIC_USER_ID = 'usr_admin'

// ─── Persistence ─────────────────────────────────────────────────────────────

// On serverless platforms (Vercel) the working directory is read-only, so the
// JSON cache must live in /tmp (the only writable, per-instance-ephemeral dir).
// Locally we keep it in ./db so the cache survives hot reloads. Telegram is
// always the durable layer; this file is only a fast local index.
const DATA_DIR = process.env.VERCEL ? '/tmp' : path.join(process.cwd(), 'db')
const STORE_PATH = path.join(DATA_DIR, 'cloudkv.json')

const EMPTY_STORE: StoreShape = { users: [], apiKeys: [], records: [], logs: [], telegramConfigs: [], shareTokens: [], files: [], collectionNames: [], adminKeys: [] }

function loadFromDisk(): StoreShape {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8')
    const parsed = JSON.parse(raw) as StoreShape
    return {
      users: parsed.users ?? [],
      apiKeys: parsed.apiKeys ?? [],
      records: parsed.records ?? [],
      logs: parsed.logs ?? [],
      telegramConfigs: parsed.telegramConfigs ?? [],
      shareTokens: parsed.shareTokens ?? [],
      files: parsed.files ?? [],
      collectionNames: parsed.collectionNames ?? [],
      adminKeys: parsed.adminKeys ?? [],
    }
  } catch {
    return { ...EMPTY_STORE }
  }
}

function saveToDisk() {
  try {
    const dir = path.dirname(STORE_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const data: StoreShape = {
      users: store.users,
      apiKeys: store.apiKeys,
      records: store.records,
      logs: store.logs,
      telegramConfigs: store.telegramConfigs,
      shareTokens: store.shareTokens,
      files: store.files,
      collectionNames: store.collectionNames,
      adminKeys: store.adminKeys,
    }
    // Atomic write: write to a temp file in the same directory, then rename.
    // `rename` is atomic on POSIX, so a crash mid-write can never leave a
    // truncated/corrupt cloudkv.json — at worst the old version stays.
    const tmpPath = STORE_PATH + '.tmp'
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8')
    fs.renameSync(tmpPath, STORE_PATH)
  } catch (err) {
    console.error('[store] failed to write JSON cache:', err)
  }
}

// ─── In-memory store (survives hot reloads via globalThis) ───────────────────

const globalForStore = globalThis as unknown as { __cloudkvStore?: StoreShape }

// Merge loaded data with the empty shape so newly-added fields (like
// telegramConfigs, passwordHash) are always present even if the cache file
// predates them. Legacy users (created before password support) get
// passwordHash coerced from undefined → null.
function ensureShape(loaded: Partial<StoreShape>): StoreShape {
  const users = (loaded.users ?? []).map((u) => ({
    ...u,
    passwordHash: u.passwordHash ?? null,
  }))
  return {
    users,
    // v3 migration: backfill scopes / expiresAt / allowlists / rate limits on
    // any key persisted before these fields existed. Missing scopes = [] which
    // means full access (backward compatible — old keys keep working unchanged).
    apiKeys: (loaded.apiKeys ?? []).map((k) => ({
      ...k,
      scopes: Array.isArray(k.scopes) ? k.scopes : [],
      expiresAt: k.expiresAt ?? null,
      collectionAllowList: Array.isArray(k.collectionAllowList) ? k.collectionAllowList : [],
      tableAllowList: Array.isArray(k.tableAllowList) ? k.tableAllowList : [],
      rateLimitPerMin: k.rateLimitPerMin ?? null,
      rateLimitMbPerDay: k.rateLimitMbPerDay ?? null,
    })),
    records: loaded.records ?? [],
    logs: loaded.logs ?? [],
    telegramConfigs: (loaded.telegramConfigs ?? []).map((c) => ({
      ...c,
      botApiBaseUrl: c.botApiBaseUrl ?? null,
    })),
    shareTokens: loaded.shareTokens ?? [],
    // Backfill `storageMode`, `linkRevokedAt`, and `botApiBaseUrl` on legacy
    // file records (created before these fields existed). Old files defaulted
    // to the env bot, so we treat them as 'server' — correct for any file
    // uploaded before the server-vs-custom split, since the only path was env
    // fallback.
    files: (loaded.files ?? []).map((f) => ({
      ...f,
      storageMode: (f.storageMode ?? 'server') as 'server' | 'custom',
      linkRevokedAt: f.linkRevokedAt ?? null,
      botApiBaseUrl: f.botApiBaseUrl ?? null,
    })),
    collectionNames: loaded.collectionNames ?? [],
    adminKeys: loaded.adminKeys ?? [],
  }
}

/**
 * Backfill any missing fields on an EXISTING store object IN PLACE — and
 * return the SAME reference.
 *
 * This is critical: in dev mode Turbopack can re-evaluate this module, which
 * would normally call `ensureShape(globalStore)` and return a NEW object. If
 * that happened, route handlers that imported the module before the
 * re-evaluation would keep mutating the OLD store, while freshly-imported
 * handlers (e.g. `/f/[id]` after an edit) would read from the NEW (stale)
 * copy. The symptom: a file is uploaded (written to store-A + disk), the
 * `/v1/files` list sees it, but `/f/<id>` returns 404 because it searches
 * store-B. Mutating in place guarantees every module instance shares one
 * mutable store object.
 */
function backfillInPlace(existing: StoreShape): StoreShape {
  if (!Array.isArray(existing.users)) existing.users = []
  for (const u of existing.users) {
    if (u.passwordHash === undefined) u.passwordHash = null
  }
  if (!Array.isArray(existing.apiKeys)) existing.apiKeys = []
  if (!Array.isArray(existing.records)) existing.records = []
  if (!Array.isArray(existing.logs)) existing.logs = []
  if (!Array.isArray(existing.telegramConfigs)) existing.telegramConfigs = []
  for (const c of existing.telegramConfigs) {
    if (c.botApiBaseUrl === undefined) c.botApiBaseUrl = null
  }
  if (!Array.isArray(existing.shareTokens)) existing.shareTokens = []
  if (!Array.isArray(existing.files)) existing.files = []
  for (const f of existing.files) {
    if (f.storageMode === undefined) f.storageMode = 'server'
    if (f.linkRevokedAt === undefined) f.linkRevokedAt = null
    if (f.botApiBaseUrl === undefined) f.botApiBaseUrl = null
  }
  if (!Array.isArray(existing.collectionNames)) existing.collectionNames = []
  if (!Array.isArray(existing.adminKeys)) existing.adminKeys = []
  return existing
}

const store: StoreShape = globalForStore.__cloudkvStore
  ? backfillInPlace(globalForStore.__cloudkvStore)
  : (globalForStore.__cloudkvStore = ensureShape(loadFromDisk()))

// Seed the bootstrap admin key if it's missing (idempotent — runs on every
// cold boot but only writes once).
seedBootstrapAdminKey()

// Cold-boot rehydration: if Telegram is configured (env bot token + chat id),
// pull the pinned manifest and restore everything (users, keys, records, logs,
// files, …) that's missing from the local cache.
//
// V4 flow: on cold boot we FIRST try to migrate V3→V4 (which is a no-op if a
// V4 index is already pinned). If migration runs, it restores the full state
// from the V3 document. If we're already in V4 mode, the per-account
// rehydrateAccountFromTelegram() calls (triggered by auth-on-miss) fetch each
// account's data on demand. The legacy rehydrateFromTelegram() is kept as a
// fallback for the case where no V4 index exists AND migration fails.
//
// On Vercel (serverless), every cold boot starts with an empty /tmp + empty
// in-memory store — so we ALWAYS rehydrate there. Locally, we only rehydrate
// when the cache is empty (to avoid hammering Telegram on every dev-server
// reload). Fire-and-forget — never blocks startup. The actual fetch happens
// on the next tick so module loading isn't delayed.
//
// NOTE: this is fire-and-forget. If a request comes in before rehydration
// completes, the auth layer's rehydrate-on-miss fallback (in authenticate())
// handles it — it awaits rehydrateFromTelegram()/rehydrateAccountFromTelegram()
// and retries the key lookup.
const isServerless = !!process.env.VERCEL
const localNeedsRehydrate = store.users.length === 0 || store.apiKeys.length === 0
if (isServerless || localNeedsRehydrate) {
  setImmediate(() => {
    void (async () => {
      // 1. Try V4 migration first (no-op if already migrated). This restores
      //    the full state from the V3 document if it runs.
      try {
        const m = await migrateV3ToV4()
        if (m.migrated) {
          // Migration restored everything — done.
          return
        }
        if (m.accounts > 0) {
          // Already in V4 mode. Per-account rehydration happens on demand via
          // auth-on-miss. But to warm the admin panel, pull the __system__
          // account + every account listed in the index.
          try {
            await rehydrateAccountFromTelegram(SYSTEM_ACCOUNT_ID)
          } catch { /* best-effort */ }
          return
        }
      } catch (err) {
        console.error('[store] V3→V4 migration failed:', err)
      }
      // 2. Fallback: legacy V3 full-state rehydration.
      try {
        await rehydrateFromTelegram()
      } catch (err) {
        console.error('[store] cold-boot rehydrate failed:', err)
      }
    })()
  })
} else {
  // Local dev with a warm cache: still detect V4 mode so the admin panel's
  // Storage tab shows the correct status + per-account manifests. This is a
  // single cheap getChat call (no rehydration, just sets v4Mode + caches the
  // index). Fire-and-forget.
  setImmediate(() => {
    void getAccountIndex().catch(() => {
      /* best-effort — V3 mode remains active */
    })
  })
}

// ─── ID helpers ──────────────────────────────────────────────────────────────

function cuid(): string {
  return (
    Date.now().toString(36) +
    crypto.randomBytes(8).toString('hex')
  )
}

export function generateUserId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.randomBytes(6)
  let out = 'usr_'
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length]
  return out
}

export function generateApiKey(): string {
  return 'kv_live_' + crypto.randomBytes(28).toString('hex').slice(0, 28)
}

// ─── User operations ─────────────────────────────────────────────────────────

export function createUser(opts: {
  userId: string
  name?: string | null
  email?: string | null
  /** Plaintext password — hashed before storage. Optional (CLI accounts may omit). */
  password?: string | null
  plan?: string
}): { user: UserRecord; apiKey: ApiKeyRecord; apiKeyRecord: ApiKeyRecord } {
  const now = new Date().toISOString()
  const user: UserRecord = {
    id: cuid(),
    userId: opts.userId,
    name: opts.name ?? null,
    email: opts.email ?? null,
    passwordHash: opts.password ? hashPassword(opts.password) : null,
    plan: opts.plan ?? 'unlimited',
    createdAt: now,
    updatedAt: now,
  }
  const apiKey: ApiKeyRecord = {
    id: cuid(),
    key: generateApiKey(),
    name: opts.name ? `${opts.name} · default` : 'default',
    userId: user.id,
    createdAt: now,
    lastUsedAt: null,
    revoked: false,
    scopes: [],
    expiresAt: null,
    collectionAllowList: [],
    tableAllowList: [],
    rateLimitPerMin: null,
    rateLimitMbPerDay: null,
  }
  store.users.push(user)
  store.apiKeys.push(apiKey)
  saveToDisk()
  // V4: sync this account's own manifest (creates the account entry in the
  // pinned index on first sync). Falls back to the legacy global sync if not
  // yet in V4 mode.
  scheduleAccountSync(user.userId)
  // Also push a per-user manifest to the user's OWN custom chat if they have
  // one configured (they won't at signup, but this is a no-op then).
  void syncUserIdentityToTelegram(user.id)
  return { user, apiKey, apiKeyRecord: apiKey }
}

export function findUserByDbId(dbUserId: string): UserRecord | undefined {
  return store.users.find((u) => u.id === dbUserId)
}

export function findUserByPublicId(userId: string): UserRecord | undefined {
  return store.users.find((u) => u.userId === userId)
}

/** Find a user by their (case-insensitive) email. Returns undefined if not found or email is null. */
export function findUserByEmail(email: string): UserRecord | undefined {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return undefined
  return store.users.find((u) => u.email && u.email.toLowerCase() === normalized)
}

/**
 * Verify an email + password pair and return the matching user.
 * Used by the email+password recovery login flow: when a user has lost their
 * API key, they can sign back in with the email + password they registered
 * with to retrieve a working key. Returns null on any mismatch.
 */
export function findUserByCredentials(
  email: string,
  password: string,
): UserRecord | null {
  const user = findUserByEmail(email)
  if (!user) return null
  if (!verifyPassword(password, user.passwordHash)) return null
  return user
}

/**
 * Set or update a user's password. Used by an authenticated "set password"
 * flow so legacy accounts (created without a password) can add one later.
 * Returns the updated user, or null if the user doesn't exist.
 */
export function setUserPassword(
  dbUserId: string,
  password: string,
): UserRecord | null {
  const user = store.users.find((u) => u.id === dbUserId)
  if (!user) return null
  user.passwordHash = hashPassword(password)
  user.updatedAt = new Date().toISOString()
  saveToDisk()
  // V4: re-sync this account's own manifest so the new password hash is
  // persisted to the Telegram public database.
  scheduleAccountSyncForDbUser(dbUserId)
  void syncUserIdentityToTelegram(user.id)
  return user
}

export function findUserByApiKey(key: string): {
  user: UserRecord
  apiKey: ApiKeyRecord
} | null {
  const apiKey = store.apiKeys.find((k) => k.key === key && !k.revoked)
  if (!apiKey) return null
  const user = store.users.find((u) => u.id === apiKey.userId)
  if (!user) return null
  // Touch lastUsedAt (fire-and-forget save)
  apiKey.lastUsedAt = new Date().toISOString()
  saveToDisk()
  return { user, apiKey }
}

/**
 * Resolve a raw API key string to its full ApiKeyRecord (without touching
 * lastUsedAt and without resolving the user). Used by authorize() to inspect
 * scopes / expiry / allowlists / rate limits on every protected request.
 */
export function findApiKeyRecord(key: string): ApiKeyRecord | null {
  return store.apiKeys.find((k) => k.key === key && !k.revoked) ?? null
}

// ─── ApiKey operations ───────────────────────────────────────────────────────

export function listApiKeys(dbUserId: string): ApiKeyRecord[] {
  return store.apiKeys
    .filter((k) => k.userId === dbUserId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/**
 * Mint a new API key. Opts.scopes empty/omitted = full access (backward
 * compatible). All other opts default to "no restriction".
 */
export function createApiKey(
  dbUserId: string,
  name: string,
  opts: ApiKeyOpts = {},
): ApiKeyRecord {
  const now = new Date().toISOString()
  const apiKey: ApiKeyRecord = {
    id: cuid(),
    key: generateApiKey(),
    name,
    userId: dbUserId,
    createdAt: now,
    lastUsedAt: null,
    revoked: false,
    scopes: normaliseScopes(opts.scopes),
    expiresAt: normaliseExpiry(opts.expiresAt),
    collectionAllowList: normaliseAllowList(opts.collectionAllowList),
    tableAllowList: normaliseAllowList(opts.tableAllowList),
    rateLimitPerMin: normalisePositiveInt(opts.rateLimitPerMin),
    rateLimitMbPerDay: normalisePositiveInt(opts.rateLimitMbPerDay),
  }
  store.apiKeys.push(apiKey)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  void syncUserIdentityToTelegram(dbUserId)
  return apiKey
}

/**
 * Update an existing API key's restrictions. Only the fields supplied in opts
 * are changed; omitted fields keep their current value. Pass `null`
 * explicitly to clear a field (e.g. expiresAt: null → never expire).
 */
export function updateApiKey(
  dbUserId: string,
  keyId: string,
  opts: Partial<ApiKeyOpts>,
): ApiKeyRecord | null {
  const apiKey = store.apiKeys.find(
    (k) => k.id === keyId && k.userId === dbUserId,
  )
  if (!apiKey) return null
  if (opts.scopes !== undefined) apiKey.scopes = normaliseScopes(opts.scopes)
  if (opts.expiresAt !== undefined) apiKey.expiresAt = normaliseExpiry(opts.expiresAt)
  if (opts.collectionAllowList !== undefined)
    apiKey.collectionAllowList = normaliseAllowList(opts.collectionAllowList)
  if (opts.tableAllowList !== undefined)
    apiKey.tableAllowList = normaliseAllowList(opts.tableAllowList)
  if (opts.rateLimitPerMin !== undefined)
    apiKey.rateLimitPerMin = normalisePositiveInt(opts.rateLimitPerMin)
  if (opts.rateLimitMbPerDay !== undefined)
    apiKey.rateLimitMbPerDay = normalisePositiveInt(opts.rateLimitMbPerDay)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  void syncUserIdentityToTelegram(dbUserId)
  return apiKey
}

export function revokeApiKey(
  dbUserId: string,
  keyId: string,
): ApiKeyRecord | null {
  const apiKey = store.apiKeys.find(
    (k) => k.id === keyId && k.userId === dbUserId,
  )
  if (!apiKey) return null
  apiKey.revoked = true
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  void syncUserIdentityToTelegram(dbUserId)
  return apiKey
}

// ─── ApiKey option normalisers ───────────────────────────────────────────────

function normaliseScopes(scopes: ApiKeyScope[] | undefined): ApiKeyScope[] {
  if (!Array.isArray(scopes)) return []
  const seen = new Set<ApiKeyScope>()
  const out: ApiKeyScope[] = []
  for (const s of scopes) {
    if (ALL_API_KEY_SCOPES.includes(s) && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

function normaliseExpiry(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null
  const t = Date.parse(expiresAt)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

function normaliseAllowList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of list) {
    const s = String(item ?? '').trim()
    if (s && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

function normalisePositiveInt(n: number | null | undefined): number | null {
  if (n === null || n === undefined) return null
  const i = Math.floor(Number(n))
  if (!Number.isFinite(i) || i <= 0) return null
  return i
}

// ─── Identity manifest (Telegram-backed recovery) ────────────────────────────
//
// Every identity mutation (createUser / createApiKey / revokeApiKey) mirrors
// the full identity state to the Telegram chat's PINNED message. Because
// `getChat` returns the pinned message text, we can read it back on cold boot
// or on an auth miss — making API keys survive full local-store resets.

interface IdentityManifest {
  cloudkv: true
  version: 3
  exportedAt: string
  users: UserRecord[]
  apiKeys: ApiKeyRecord[]
  /** v2+: full app state so serverless (Vercel) cold boots restore everything. */
  records?: RecordEntry[]
  logs?: LogEntry[]
  files?: FileRecord[]
  shareTokens?: ShareTokenRecord[]
  collectionNames?: CollectionNameRecord[]
  telegramConfigs?: TelegramConfigRecord[]
  adminKeys?: AdminKeyRecord[]
}

/**
 * Build the FULL-state manifest (every array in the store) as JSON.
 *
 * v3: ApiKeyRecord now carries scopes / expiresAt / collectionAllowList /
 * tableAllowList / rateLimitPerMin / rateLimitMbPerDay. Old v2 manifests
 * restore fine — missing fields are defaulted in restoreIdentityFromBackup.
 *
 * v2: the manifest now carries records, logs, files, shareTokens,
 * collectionNames, telegramConfigs, and adminKeys — not just users + apiKeys.
 * This is the durability layer that makes Onyx Base work on serverless:
 * the pinned Telegram document IS the database. Every write re-pins it;
 * every cold boot reads it back. Free + unlimited (Telegram is free, and
 * documents support up to 50 MB / 2 GB).
 */
export function buildIdentityManifest(): string {
  const manifest: IdentityManifest = {
    cloudkv: true,
    version: 3,
    exportedAt: new Date().toISOString(),
    users: store.users,
    apiKeys: store.apiKeys,
    records: store.records,
    logs: store.logs,
    files: store.files,
    shareTokens: store.shareTokens,
    collectionNames: store.collectionNames,
    telegramConfigs: store.telegramConfigs,
    adminKeys: store.adminKeys,
  }
  return JSON.stringify(manifest)
}

/**
 * Push the current FULL-state manifest to Telegram as the chat's pinned
 * **document**. Fire-and-forget — never blocks the caller. Uses env Telegram
 * creds by default (the shared platform vault). This is the "save everything
 * to Telegram automatically" half of the durability contract.
 *
 * v2: uses `sendAndPinFullState` (document upload) instead of
 * `sendAndPinManifest` (text message) so the entire store — records, logs,
 * files, etc. — fits (Telegram text messages cap at 4096 chars; documents
 * support 50 MB / 2 GB).
 *
 * NOTE: this writes to the SERVER's env Telegram chat. That chat is private
 * to the operator and NOT accessible to end users.
 */
export function syncIdentityToTelegram(chatId?: string, botToken?: string, botApiBaseUrl?: string): Promise<number | null> {
  const json = buildIdentityManifest()
  return sendAndPinFullState(json, chatId, botToken, botApiBaseUrl)
}

/**
 * Debounced full-state sync. Multiple mutations within a short window (e.g. a
 * batch of record writes) collapse into a single Telegram document upload.
 * This prevents hammering Telegram's API on rapid writes while still keeping
 * the pinned manifest current within ~1 second of the last mutation.
 *
 * Every record/file/log/share/collection mutation calls this instead of
 * syncIdentityToTelegram directly — so the full-state document always
 * reflects the latest store state, and a serverless cold boot can rehydrate
 * EVERYTHING from it.
 */
let syncTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleFullStateSync(chatId?: string, botToken?: string, botApiBaseUrl?: string): void {
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    void syncIdentityToTelegram(chatId, botToken, botApiBaseUrl).catch((err) =>
      console.error('[store] scheduled full-state sync failed:', err),
    )
  }, 1000)
}

// ─── Per-user manifest (custom-chat recovery) ────────────────────────────────
//
// When a user configures their OWN Telegram chat ID + bot token (Settings →
// Telegram chat ID), we push a manifest containing ONLY that user's record +
// their API keys + their password hash to THEIR chat as the pinned message.
// This is the user-facing recovery path: they can open their own Telegram
// chat, copy the pinned CLOUDKV_IDENTITY_MANIFEST message, and paste it into
// the "Lost your key?" box to restore. It also lets us auto-rehydrate their
// keys on email+password login (we know which chat belongs to them).

interface UserManifest {
  cloudkv: true
  version: 1
  scope: 'user'
  exportedAt: string
  user: UserRecord
  apiKeys: ApiKeyRecord[]
}

/** Build a manifest containing ONLY one user + their keys (for their chat). */
export function buildUserManifest(dbUserId: string): string | null {
  const user = store.users.find((u) => u.id === dbUserId)
  if (!user) return null
  const apiKeys = store.apiKeys.filter((k) => k.userId === dbUserId)
  const manifest: UserManifest = {
    cloudkv: true,
    version: 1,
    scope: 'user',
    exportedAt: new Date().toISOString(),
    user,
    apiKeys,
  }
  return JSON.stringify(manifest)
}

/**
 * Push the per-user manifest to the user's OWN custom Telegram chat (if they
 * have one configured). No-op when the user has no custom chat/bot token.
 * Fire-and-forget — never blocks the caller.
 */
export async function syncUserIdentityToTelegram(dbUserId: string): Promise<number | null> {
  const config = getTelegramConfig(dbUserId)
  // Need BOTH a custom chat id AND a custom bot token for the user to own
  // and be able to read back the manifest. With only a chat id (and the
  // server's env bot token), the bot can write but the user can't pin/read
  // via their own bot — so we skip the per-user push in that case.
  if (!config || !config.chatId.trim() || !config.hasCustomBotToken || !config.botToken) {
    return null
  }
  const json = buildUserManifest(dbUserId)
  if (!json) return null
  const botApiBaseUrl = config.botApiBaseUrl?.trim() || ''
  return sendAndPinManifest(json, config.chatId.trim(), config.botToken.trim(), botApiBaseUrl)
}

/**
 * Fetch + restore the per-user manifest from the user's OWN custom Telegram
 * chat. Used on email+password login to recover any keys that aren't in the
 * local store (e.g. after a sandbox reset wiped db/cloudkv.json but the user
 * had configured their own chat). Best-effort, never throws.
 */
export async function rehydrateUserFromTelegram(dbUserId: string): Promise<{
  attempted: boolean
  usersRestored: number
  keysRestored: number
  error?: string
}> {
  const config = getTelegramConfig(dbUserId)
  if (!config || !config.chatId.trim() || !config.hasCustomBotToken || !config.botToken) {
    return { attempted: false, usersRestored: 0, keysRestored: 0 }
  }
  const json = await fetchPinnedManifest(config.chatId.trim(), config.botToken.trim(), config.botApiBaseUrl?.trim() || '')
  if (json === null) {
    return { attempted: false, usersRestored: 0, keysRestored: 0 }
  }
  // A user manifest has scope:'user' and a single `user` field. Wrap it into
  // the array shape restoreIdentityFromBackup expects so we can reuse the
  // dedup + insert logic.
  try {
    const parsed = JSON.parse(json) as Partial<UserManifest> & { users?: UserRecord[]; apiKeys?: ApiKeyRecord[] }
    if (parsed && parsed.cloudkv === true && parsed.scope === 'user' && parsed.user) {
      const wrapped = JSON.stringify({
        cloudkv: true,
        version: 1,
        exportedAt: parsed.exportedAt ?? new Date().toISOString(),
        users: [parsed.user],
        apiKeys: parsed.apiKeys ?? [],
      })
      const result = restoreIdentityFromBackup(wrapped)
      if (result.ok && (result.usersRestored || result.keysRestored)) {
        console.log(`[store] rehydrated user ${dbUserId}: +${result.usersRestored} user(s), +${result.keysRestored} key(s) from their custom Telegram chat`)
      }
      return {
        attempted: true,
        usersRestored: result.usersRestored,
        keysRestored: result.keysRestored,
        error: result.error,
      }
    }
    // Fall through to the standard array-shape restore (env manifest format).
    const result = restoreIdentityFromBackup(json)
    return {
      attempted: true,
      usersRestored: result.usersRestored,
      keysRestored: result.keysRestored,
      error: result.error,
    }
  } catch (err) {
    return { attempted: true, usersRestored: 0, keysRestored: 0, error: (err as Error).message }
  }
}

interface ParsedManifest {
  cloudkv?: boolean
  version?: number
  users?: Array<Partial<UserRecord> & { id?: string; userId?: string }>
  apiKeys?: Array<Partial<ApiKeyRecord> & { id?: string; key?: string; userId?: string }>
  /** v2+: full app state. */
  records?: RecordEntry[]
  logs?: LogEntry[]
  files?: FileRecord[]
  shareTokens?: ShareTokenRecord[]
  collectionNames?: CollectionNameRecord[]
  telegramConfigs?: TelegramConfigRecord[]
  adminKeys?: AdminKeyRecord[]
}

/**
 * Rehydrate the local store from a Telegram pinned manifest (or a pasted
 * backup blob). Idempotent: users / keys that already exist locally are left
 * untouched; only missing ones are inserted. Returns a summary of what was
 * restored. This is the "fetch and match whenever it's needed" half.
 *
 * v2: also restores records, logs, files, shareTokens, collectionNames,
 * telegramConfigs, and adminKeys — so a serverless cold boot (where
 * /tmp/cloudkv.json is ephemeral) recovers the ENTIRE app state, not just
 * identity. Items are matched by their unique `id` (or composite key for
 * records) so re-running a restore never creates duplicates.
 */
export function restoreIdentityFromBackup(rawJson: string): {
  ok: boolean
  usersRestored: number
  keysRestored: number
  recordsRestored: number
  logsRestored: number
  filesRestored: number
  error?: string
} {
  let parsed: ParsedManifest
  try {
    parsed = JSON.parse(rawJson) as ParsedManifest
  } catch (err) {
    return { ok: false, usersRestored: 0, keysRestored: 0, recordsRestored: 0, logsRestored: 0, filesRestored: 0, error: 'Invalid JSON: ' + (err as Error).message }
  }
  if (!parsed || parsed.cloudkv !== true || !Array.isArray(parsed.users) || !Array.isArray(parsed.apiKeys)) {
    return { ok: false, usersRestored: 0, keysRestored: 0, recordsRestored: 0, logsRestored: 0, filesRestored: 0, error: 'Not a Onyx Base identity manifest.' }
  }

  let usersRestored = 0
  let keysRestored = 0
  let recordsRestored = 0
  let logsRestored = 0
  let filesRestored = 0

  for (const u of parsed.users) {
    if (!u.id || !u.userId) continue
    const exists = store.users.some((x) => x.id === u.id || x.userId === u.userId)
    if (exists) {
      // If the local user is missing a password hash but the backup has one,
      // backfill it so the user can still do email+password recovery after a
      // partial restore.
      if (u.passwordHash) {
        const local = store.users.find((x) => x.id === u.id || x.userId === u.userId)
        if (local && !local.passwordHash) {
          local.passwordHash = u.passwordHash
          local.updatedAt = new Date().toISOString()
          usersRestored++
        }
      }
      continue
    }
    store.users.push({
      id: u.id,
      userId: u.userId,
      name: u.name ?? null,
      email: u.email ?? null,
      passwordHash: u.passwordHash ?? null,
      plan: u.plan ?? 'unlimited',
      createdAt: u.createdAt ?? new Date().toISOString(),
      updatedAt: u.updatedAt ?? u.createdAt ?? new Date().toISOString(),
    })
    usersRestored++
  }

  for (const k of parsed.apiKeys) {
    if (!k.id || !k.key || !k.userId) continue
    const exists = store.apiKeys.some((x) => x.id === k.id || x.key === k.key)
    if (exists) {
      // v2→v3 migration: backfill new fields on a pre-existing local key that
      // was restored from an older manifest and is still missing them.
      const local = store.apiKeys.find((x) => x.id === k.id || x.key === k.key)
      if (local) {
        if (!Array.isArray(local.scopes)) local.scopes = Array.isArray(k.scopes) ? k.scopes : []
        if (local.expiresAt === undefined) local.expiresAt = k.expiresAt ?? null
        if (!Array.isArray(local.collectionAllowList))
          local.collectionAllowList = Array.isArray(k.collectionAllowList) ? k.collectionAllowList : []
        if (!Array.isArray(local.tableAllowList))
          local.tableAllowList = Array.isArray(k.tableAllowList) ? k.tableAllowList : []
        if (local.rateLimitPerMin === undefined) local.rateLimitPerMin = k.rateLimitPerMin ?? null
        if (local.rateLimitMbPerDay === undefined) local.rateLimitMbPerDay = k.rateLimitMbPerDay ?? null
      }
      continue
    }
    // v3 restored key (with v2 manifest fields defaulted for safety).
    store.apiKeys.push({
      id: k.id,
      key: k.key,
      name: k.name ?? 'restored',
      userId: k.userId,
      createdAt: k.createdAt ?? new Date().toISOString(),
      lastUsedAt: k.lastUsedAt ?? null,
      revoked: k.revoked ?? false,
      scopes: Array.isArray(k.scopes) ? k.scopes.filter((s) => ALL_API_KEY_SCOPES.includes(s)) : [],
      expiresAt: k.expiresAt ?? null,
      collectionAllowList: Array.isArray(k.collectionAllowList) ? k.collectionAllowList : [],
      tableAllowList: Array.isArray(k.tableAllowList) ? k.tableAllowList : [],
      rateLimitPerMin: k.rateLimitPerMin ?? null,
      rateLimitMbPerDay: k.rateLimitMbPerDay ?? null,
    })
    keysRestored++
  }

  // ── v2: restore records (match by userId + collection + key) ──
  if (Array.isArray(parsed.records)) {
    for (const r of parsed.records) {
      if (!r || !r.userId || !r.collection || !r.key) continue
      const exists = store.records.some(
        (x) => x.userId === r.userId && x.collection === r.collection && x.key === r.key,
      )
      if (exists) continue
      store.records.push({
        id: r.id || (r.userId + ':' + r.collection + ':' + r.key),
        userId: r.userId,
        collection: r.collection,
        key: r.key,
        value: r.value ?? '',
        valueType: r.valueType ?? 'string',
        telegramMessageId: r.telegramMessageId ?? null,
        createdAt: r.createdAt ?? new Date().toISOString(),
        updatedAt: r.updatedAt ?? r.createdAt ?? new Date().toISOString(),
      })
      recordsRestored++
    }
  }

  // ── v2: restore logs (match by id) ──
  if (Array.isArray(parsed.logs)) {
    for (const l of parsed.logs) {
      if (!l || !l.id) continue
      if (store.logs.some((x) => x.id === l.id)) continue
      store.logs.push({
        id: l.id,
        userId: l.userId ?? '',
        action: l.action ?? 'unknown',
        key: l.key ?? null,
        detail: l.detail ?? null,
        source: l.source ?? 'api',
        ip: l.ip ?? null,
        createdAt: l.createdAt ?? new Date().toISOString(),
      })
      logsRestored++
    }
  }

  // ── v2: restore files (match by id) ──
  if (Array.isArray(parsed.files)) {
    for (const f of parsed.files) {
      if (!f || !f.id) continue
      if (store.files.some((x) => x.id === f.id)) continue
      store.files.push(f as FileRecord)
      filesRestored++
    }
  }

  // ── v2: restore shareTokens (match by id) ──
  if (Array.isArray(parsed.shareTokens)) {
    for (const t of parsed.shareTokens) {
      if (!t || !t.id) continue
      if (store.shareTokens.some((x) => x.id === t.id)) continue
      store.shareTokens.push(t as ShareTokenRecord)
    }
  }

  // ── v2: restore collectionNames (match by userId + name) ──
  if (Array.isArray(parsed.collectionNames)) {
    for (const c of parsed.collectionNames) {
      if (!c || !c.userId || !c.name) continue
      if (store.collectionNames.some((x) => x.userId === c.userId && x.name === c.name)) continue
      store.collectionNames.push({
        userId: c.userId,
        name: c.name,
        createdAt: c.createdAt ?? new Date().toISOString(),
      })
    }
  }

  // ── v2: restore telegramConfigs (match by userId) ──
  if (Array.isArray(parsed.telegramConfigs)) {
    for (const tc of parsed.telegramConfigs) {
      if (!tc || !tc.userId) continue
      if (store.telegramConfigs.some((x) => x.userId === tc.userId)) continue
      store.telegramConfigs.push(tc as TelegramConfigRecord)
    }
  }

  // ── v2: restore adminKeys (match by key) ──
  if (Array.isArray(parsed.adminKeys)) {
    for (const ak of parsed.adminKeys) {
      if (!ak || !ak.key) continue
      if (store.adminKeys.some((x) => x.key === ak.key)) continue
      store.adminKeys.push({
        id: ak.id ?? ('admin_' + ak.key.slice(-8)),
        key: ak.key,
        label: ak.label ?? 'restored',
        createdAt: ak.createdAt ?? new Date().toISOString(),
        createdBy: ak.createdBy ?? 'restored',
        promotedFromUserId: ak.promotedFromUserId ?? null,
        promotedFromUserEmail: ak.promotedFromUserEmail ?? null,
        revoked: ak.revoked ?? false,
      })
    }
  }

  if (usersRestored || keysRestored || recordsRestored || logsRestored || filesRestored) saveToDisk()
  return { ok: true, usersRestored, keysRestored, recordsRestored, logsRestored, filesRestored }
}

/**
 * Fetch the pinned identity manifest from Telegram (via getChat) and restore
 * any missing users / keys into the local store. Best-effort: returns a
 * summary but never throws. Used on cold boot and on auth miss.
 *
 * v2: also restores records, logs, files, shareTokens, collectionNames,
 * telegramConfigs, adminKeys — the ENTIRE app state. This is what makes
 * Onyx Base durable on serverless (Vercel): every cold boot pulls the full
 * state from the pinned Telegram document.
 */
export async function rehydrateFromTelegram(chatId?: string, botToken?: string, botApiBaseUrl?: string): Promise<{
  attempted: boolean
  usersRestored: number
  keysRestored: number
  recordsRestored: number
  logsRestored: number
  filesRestored: number
  error?: string
}> {
  const json = await fetchPinnedManifest(chatId, botToken, botApiBaseUrl)
  if (json === null) {
    return { attempted: false, usersRestored: 0, keysRestored: 0, recordsRestored: 0, logsRestored: 0, filesRestored: 0 }
  }
  const result = restoreIdentityFromBackup(json)
  if (result.ok && (result.usersRestored || result.keysRestored || result.recordsRestored || result.logsRestored || result.filesRestored)) {
    console.log(`[store] rehydrated from Telegram: ${result.usersRestored} user(s), ${result.keysRestored} apikey(s), ${result.recordsRestored} record(s), ${result.logsRestored} log(s), ${result.filesRestored} file(s)`)
  }
  return {
    attempted: true,
    usersRestored: result.usersRestored,
    keysRestored: result.keysRestored,
    recordsRestored: result.recordsRestored,
    logsRestored: result.logsRestored,
    filesRestored: result.filesRestored,
    error: result.error,
  }
}

// ─── V4: Per-account manifests ───────────────────────────────────────────────
//
// V4 splits the single full-state document into one document PER ACCOUNT,
// coordinated by a tiny pinned index. This section implements:
//   - buildAccountManifest(userId): serialize one account's data.
//   - syncAccountManifestToTelegram(userId): upload + index update for one account.
//   - rehydrateAccountFromTelegram(userId): fetch + restore one account.
//   - migrateV3ToV4(): one-time split of the legacy full-state blob.
//   - scheduleAccountSync(userId): debounced per-account sync (replaces the
//     global scheduleFullStateSync for V4-mode writes).
//
// The V3 full-state path (buildIdentityManifest / syncIdentityToTelegram /
// rehydrateFromTelegram) is KEPT for backward compatibility and as a fallback.
// V4 does NOT delete the V3 pinned document — it just unpins it (by pinning
// the V4 index on top) and leaves it in the chat history as a backup.

/** In-memory cache of the V4 account index (survives across requests). */
let accountIndexCache: AccountIndex | null = null

/** True once we've confirmed the pinned message is a V4 index (set by fetchAccountIndex). */
let v4ModeActive = false

/**
 * Build the V4 manifest for a single account (or the __system__ account).
 * Returns null if the account doesn't exist locally.
 */
export function buildAccountManifest(userId: string): AccountManifest | null {
  // __system__ account: admin user + admin keys + any apiKeys owned by 'admin'.
  if (userId === SYSTEM_ACCOUNT_ID) {
    return {
      cloudkv: true,
      kind: 'account-manifest',
      version: 4,
      userId: SYSTEM_ACCOUNT_ID,
      exportedAt: new Date().toISOString(),
      user: null,
      apiKeys: store.apiKeys.filter((k) => k.userId === ADMIN_DB_USER_ID),
      records: [],
      logs: store.logs.filter((l) => l.userId === ADMIN_DB_USER_ID),
      files: [],
      shareTokens: [],
      collectionNames: [],
      telegramConfigs: [],
      adminKeys: store.adminKeys,
    }
  }
  // Regular user account: match by public userId (usr_xxx).
  const user = store.users.find((u) => u.userId === userId && u.id !== ADMIN_DB_USER_ID)
  if (!user) return null
  return {
    cloudkv: true,
    kind: 'account-manifest',
    version: 4,
    userId: user.userId,
    exportedAt: new Date().toISOString(),
    user,
    apiKeys: store.apiKeys.filter((k) => k.userId === user.id),
    records: store.records.filter((r) => r.userId === user.id),
    logs: store.logs.filter((l) => l.userId === user.id),
    files: store.files.filter((f) => f.userId === user.id),
    shareTokens: store.shareTokens.filter((t) => t.userId === user.id),
    collectionNames: store.collectionNames.filter((c) => c.userId === user.id),
    telegramConfigs: store.telegramConfigs.filter((t) => t.userId === user.id),
  }
}

/**
 * Restore a single V4 account manifest into the local store. Idempotent —
 * existing matching items are left untouched. Used by rehydrateAccountFromTelegram.
 */
function restoreAccountManifest(m: AccountManifest): {
  users: number
  apiKeys: number
  records: number
  logs: number
  files: number
} {
  let usersRestored = 0
  let keysRestored = 0
  let recordsRestored = 0
  let logsRestored = 0
  let filesRestored = 0

  // User (skip for __system__).
  if (m.userId !== SYSTEM_ACCOUNT_ID && m.user) {
    const u = m.user as UserRecord
    if (u.id && u.userId && !store.users.some((x) => x.id === u.id || x.userId === u.userId)) {
      store.users.push({
        id: u.id,
        userId: u.userId,
        name: u.name ?? null,
        email: u.email ?? null,
        passwordHash: u.passwordHash ?? null,
        plan: u.plan ?? 'unlimited',
        createdAt: u.createdAt ?? new Date().toISOString(),
        updatedAt: u.updatedAt ?? u.createdAt ?? new Date().toISOString(),
      })
      usersRestored++
    } else if (u.passwordHash) {
      const local = store.users.find((x) => x.id === u.id || x.userId === u.userId)
      if (local && !local.passwordHash) {
        local.passwordHash = u.passwordHash
        local.updatedAt = new Date().toISOString()
      }
    }
  }

  // API keys.
  for (const k of (m.apiKeys ?? []) as ApiKeyRecord[]) {
    if (!k.id || !k.key || !k.userId) continue
    if (store.apiKeys.some((x) => x.id === k.id || x.key === k.key)) continue
    store.apiKeys.push({
      id: k.id,
      key: k.key,
      name: k.name ?? 'restored',
      userId: k.userId,
      createdAt: k.createdAt ?? new Date().toISOString(),
      lastUsedAt: k.lastUsedAt ?? null,
      revoked: k.revoked ?? false,
      scopes: Array.isArray(k.scopes) ? k.scopes.filter((s) => ALL_API_KEY_SCOPES.includes(s)) : [],
      expiresAt: k.expiresAt ?? null,
      collectionAllowList: Array.isArray(k.collectionAllowList) ? k.collectionAllowList : [],
      tableAllowList: Array.isArray(k.tableAllowList) ? k.tableAllowList : [],
      rateLimitPerMin: k.rateLimitPerMin ?? null,
      rateLimitMbPerDay: k.rateLimitMbPerDay ?? null,
    })
    keysRestored++
  }

  // Records.
  for (const r of (m.records ?? []) as RecordEntry[]) {
    if (!r || !r.userId || !r.collection || !r.key) continue
    if (store.records.some((x) => x.userId === r.userId && x.collection === r.collection && x.key === r.key)) continue
    store.records.push({
      id: r.id || (r.userId + ':' + r.collection + ':' + r.key),
      userId: r.userId,
      collection: r.collection,
      key: r.key,
      value: r.value ?? '',
      valueType: r.valueType ?? 'string',
      telegramMessageId: r.telegramMessageId ?? null,
      createdAt: r.createdAt ?? new Date().toISOString(),
      updatedAt: r.updatedAt ?? r.createdAt ?? new Date().toISOString(),
    })
    recordsRestored++
  }

  // Logs.
  for (const l of (m.logs ?? []) as LogEntry[]) {
    if (!l || !l.id) continue
    if (store.logs.some((x) => x.id === l.id)) continue
    store.logs.push({
      id: l.id,
      userId: l.userId ?? '',
      action: l.action ?? 'unknown',
      key: l.key ?? null,
      detail: l.detail ?? null,
      source: l.source ?? 'api',
      ip: l.ip ?? null,
      createdAt: l.createdAt ?? new Date().toISOString(),
    })
    logsRestored++
  }

  // Files.
  for (const f of (m.files ?? []) as FileRecord[]) {
    if (!f || !f.id) continue
    if (store.files.some((x) => x.id === f.id)) continue
    store.files.push(f)
    filesRestored++
  }

  // Share tokens.
  for (const t of (m.shareTokens ?? []) as ShareTokenRecord[]) {
    if (!t || !t.id) continue
    if (store.shareTokens.some((x) => x.id === t.id)) continue
    store.shareTokens.push(t)
  }

  // Collection names.
  for (const c of (m.collectionNames ?? []) as CollectionNameRecord[]) {
    if (!c || !c.userId || !c.name) continue
    if (store.collectionNames.some((x) => x.userId === c.userId && x.name === c.name)) continue
    store.collectionNames.push({ userId: c.userId, name: c.name, createdAt: c.createdAt ?? new Date().toISOString() })
  }

  // Telegram configs.
  for (const tc of (m.telegramConfigs ?? []) as TelegramConfigRecord[]) {
    if (!tc || !tc.userId) continue
    if (store.telegramConfigs.some((x) => x.userId === tc.userId)) continue
    store.telegramConfigs.push(tc)
  }

  // Admin keys (only on __system__ manifest).
  if (m.userId === SYSTEM_ACCOUNT_ID && Array.isArray(m.adminKeys)) {
    for (const ak of m.adminKeys as AdminKeyRecord[]) {
      if (!ak || !ak.key) continue
      if (store.adminKeys.some((x) => x.key === ak.key)) continue
      store.adminKeys.push({
        id: ak.id ?? ('admin_' + ak.key.slice(-8)),
        key: ak.key,
        label: ak.label ?? 'restored',
        createdAt: ak.createdAt ?? new Date().toISOString(),
        createdBy: ak.createdBy ?? 'restored',
        promotedFromUserId: ak.promotedFromUserId ?? null,
        promotedFromUserEmail: ak.promotedFromUserEmail ?? null,
        revoked: ak.revoked ?? false,
      })
    }
  }

  if (usersRestored || keysRestored || recordsRestored || logsRestored || filesRestored) saveToDisk()
  return { users: usersRestored, apiKeys: keysRestored, records: recordsRestored, logs: logsRestored, files: filesRestored }
}

/**
 * Fetch the V4 index (cached after first fetch). Sets v4ModeActive=true if the
 * pinned message is our V4 index. Returns null if not in V4 mode (caller should
 * fall back to the V3 path).
 */
export async function getAccountIndex(): Promise<AccountIndex | null> {
  if (accountIndexCache) return accountIndexCache
  const idx = await fetchAccountIndex()
  if (idx) {
    accountIndexCache = idx
    v4ModeActive = true
  }
  return idx
}

/**
 * Sync ONE account's manifest to Telegram + update the pinned index. Used after
 * a write that affects only one account (the common case). Debounced per-account
 * via scheduleAccountSync.
 *
 * Returns the updated index entry, or null on failure.
 */
export async function syncAccountManifestToTelegram(userId: string): Promise<AccountIndexEntry | null> {
  const manifest = buildAccountManifest(userId)
  if (!manifest) return null
  const idx = (await getAccountIndex()) ?? {
    cloudkv: true as const,
    kind: 'account-index' as const,
    version: 4 as const,
    exportedAt: new Date().toISOString(),
    accounts: {},
  }
  const existing = idx.accounts[userId]
  const sent = await sendAccountManifest(manifest, existing?.messageId)
  if (!sent) return null
  const recordCount = (manifest.records ?? []).length
  const entry: AccountIndexEntry = {
    userId,
    messageId: sent.messageId,
    fileId: sent.fileId,
    bytes: sent.bytes,
    recordCount,
    updatedAt: new Date().toISOString(),
  }
  idx.accounts[userId] = entry
  idx.exportedAt = new Date().toISOString()
  await pinAccountIndex(idx)
  accountIndexCache = idx
  v4ModeActive = true
  return entry
}

/**
 * Fetch + restore ONE account's manifest from Telegram (by userId). Used by the
 * auth layer on a key-miss: instead of pulling the whole-world V3 document, we
 * pull only the affected account's document. Best-effort, never throws.
 */
export async function rehydrateAccountFromTelegram(userId: string): Promise<{
  attempted: boolean
  users: number
  apiKeys: number
  records: number
  logs: number
  files: number
  error?: string
}> {
  const idx = await getAccountIndex()
  if (!idx) return { attempted: false, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0 }
  const entry = idx.accounts[userId]
  if (!entry) return { attempted: false, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0 }
  try {
    const manifest = await fetchAccountManifest(entry.fileId)
    if (!manifest) return { attempted: true, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0, error: 'download failed' }
    const r = restoreAccountManifest(manifest)
    if (r.users || r.apiKeys || r.records || r.logs || r.files) {
      console.log(`[store] V4 rehydrated account ${userId}: +${r.users} user, +${r.apiKeys} keys, +${r.records} records, +${r.logs} logs, +${r.files} files`)
    }
    return { attempted: true, ...r }
  } catch (err) {
    return { attempted: true, users: 0, apiKeys: 0, records: 0, logs: 0, files: 0, error: (err as Error).message }
  }
}

/**
 * One-time V3 → V4 migration. Reads the legacy full-state pinned document,
 * splits it into one manifest per account (+ one __system__ manifest), uploads
 * each, and pins the V4 index. The V3 document is NOT deleted — it stays in
 * the chat history as a backup.
 *
 * Idempotent: if a V4 index is already pinned, this is a no-op. Safe to call
 * on every cold boot.
 */
export async function migrateV3ToV4(): Promise<{
  migrated: boolean
  accounts: number
  error?: string
}> {
  // Already in V4 mode? Nothing to do.
  if (v4ModeActive || accountIndexCache) {
    return { migrated: false, accounts: accountIndexCache ? Object.keys(accountIndexCache.accounts).length : 0 }
  }
  const existing = await fetchAccountIndex()
  if (existing) {
    accountIndexCache = existing
    v4ModeActive = true
    return { migrated: false, accounts: Object.keys(existing.accounts).length }
  }
  // No V4 index pinned → pull the V3 full-state document and split it.
  const v3Json = await fetchPinnedManifest()
  if (!v3Json) {
    return { migrated: false, accounts: 0 }
  }
  let parsed: ParsedManifest
  try {
    parsed = JSON.parse(v3Json) as ParsedManifest
  } catch (err) {
    return { migrated: false, accounts: 0, error: 'V3 manifest JSON parse failed: ' + (err as Error).message }
  }
  if (!parsed || parsed.cloudkv !== true) {
    return { migrated: false, accounts: 0 }
  }
  // Ensure the local store has everything from V3 first (so buildAccountManifest
  // can serialize per-account from the in-memory store).
  restoreIdentityFromBackup(v3Json)

  // Build the list of accounts to split into: every real user + __system__.
  const accountIds = [
    ...store.users.filter((u) => u.id !== ADMIN_DB_USER_ID).map((u) => u.userId),
    SYSTEM_ACCOUNT_ID,
  ]

  const newIndex: AccountIndex = {
    cloudkv: true,
    kind: 'account-index',
    version: 4,
    exportedAt: new Date().toISOString(),
    accounts: {},
  }
  let migratedCount = 0
  for (const userId of accountIds) {
    const manifest = buildAccountManifest(userId)
    if (!manifest) continue
    const sent = await sendAccountManifest(manifest)
    if (!sent) {
      console.error(`[store] V4 migration: failed to upload manifest for ${userId}`)
      continue
    }
    newIndex.accounts[userId] = {
      userId,
      messageId: sent.messageId,
      fileId: sent.fileId,
      bytes: sent.bytes,
      recordCount: (manifest.records ?? []).length,
      updatedAt: new Date().toISOString(),
    }
    migratedCount++
  }
  if (migratedCount === 0) {
    return { migrated: false, accounts: 0, error: 'no accounts uploaded' }
  }
  const pinned = await pinAccountIndex(newIndex)
  if (!pinned) {
    return { migrated: false, accounts: migratedCount, error: 'index pin failed' }
  }
  accountIndexCache = newIndex
  v4ModeActive = true
  console.log(`[store] V3→V4 migration complete: ${migratedCount} account manifest(s) uploaded, index pinned. V3 document left in chat as backup.`)
  return { migrated: true, accounts: migratedCount }
}

/**
 * Per-account debounced sync. Each account gets its own 1s timer — a burst of
 * writes by user A doesn't delay user B's sync. Falls back to the legacy global
 * full-state sync if not yet in V4 mode (e.g. migration hasn't run).
 */
const accountSyncTimers = new Map<string, ReturnType<typeof setTimeout>>()
export function scheduleAccountSync(userId: string): void {
  // If we're not yet in V4 mode and haven't attempted migration, fall back to
  // the legacy global sync. The cold-boot migration (in instrumentation /
  // module load) will switch us to V4 shortly.
  if (!v4ModeActive) {
    scheduleFullStateSync()
    return
  }
  const existing = accountSyncTimers.get(userId)
  if (existing) clearTimeout(existing)
  const timer = setTimeout(() => {
    accountSyncTimers.delete(userId)
    void syncAccountManifestToTelegram(userId).catch((err) =>
      console.error(`[store] scheduled account sync failed for ${userId}:`, err),
    )
  }, 1000)
  accountSyncTimers.set(userId, timer)
}

/**
 * Admin helper: list every account's V4 index entry (for the admin panel).
 * Returns null if not yet in V4 mode.
 */
export async function adminListAccountManifests(): Promise<AccountIndexEntry[] | null> {
  const idx = await getAccountIndex()
  if (!idx) return null
  return Object.values(idx.accounts).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** Whether the store has completed V3→V4 migration (V4 index is pinned). */
export function isV4ModeActive(): boolean {
  return v4ModeActive
}

/**
 * Resolve an internal dbUserId to the public userId (`usr_xxx`) used as the V4
 * account key. Admin-user records map to the `__system__` account. Returns
 * null if the user isn't in the store (caller should fall back to the legacy
 * global sync).
 */
function publicUserIdForDbUser(dbUserId: string): string | null {
  if (dbUserId === ADMIN_DB_USER_ID) return SYSTEM_ACCOUNT_ID
  const u = store.users.find((x) => x.id === dbUserId)
  return u ? u.userId : null
}

/**
 * Schedule a per-account V4 sync for the account that owns `dbUserId`. Falls
 * back to the legacy global full-state sync when not in V4 mode or when the
 * user can't be resolved. This is the drop-in replacement for
 * `scheduleFullStateSync()` at every write site.
 */
function scheduleAccountSyncForDbUser(dbUserId: string): void {
  const pub = publicUserIdForDbUser(dbUserId)
  if (pub) {
    scheduleAccountSync(pub)
  } else {
    // Unknown user (shouldn't happen) — fall back to global sync.
    scheduleFullStateSync()
  }
}

// ─── Record (KV) operations ──────────────────────────────────────────────────

export function findRecord(
  dbUserId: string,
  collection: string,
  key: string,
): RecordEntry | undefined {
  return store.records.find(
    (r) => r.userId === dbUserId && r.collection === collection && r.key === key,
  )
}

export function upsertRecord(
  dbUserId: string,
  publicUserId: string,
  opts: {
    collection: string
    key: string
    value: string
    valueType: string
    chatId?: string
    botToken?: string
    botApiBaseUrl?: string
  },
): { record: RecordEntry; created: boolean } {
  const existing = findRecord(dbUserId, opts.collection, opts.key)
  const now = new Date().toISOString()
  const chatId = opts.chatId
  const botToken = opts.botToken
  const botApiBaseUrl = opts.botApiBaseUrl

  if (existing) {
    existing.value = opts.value
    existing.valueType = opts.valueType
    existing.updatedAt = now
    saveToDisk()
    scheduleAccountSyncForDbUser(dbUserId)

    // Edit the existing Telegram backup message.
    const payload: TelegramPayload = {
      owner: publicUserId,
      collection: opts.collection,
      key: opts.key,
      value: JSON.parse(opts.value),
      valueType: opts.valueType,
      updatedAt: Math.floor(Date.now() / 1000),
      op: 'SET',
    }
    if (existing.telegramMessageId) {
      void editKvMessage(existing.telegramMessageId, payload, chatId, botToken, botApiBaseUrl)
    } else {
      void sendKvMessage(payload, chatId, botToken, botApiBaseUrl).then((msgId) => {
        if (msgId) {
          existing.telegramMessageId = msgId
          saveToDisk()
        }
      })
    }
    return { record: existing, created: false }
  }

  const record: RecordEntry = {
    id: cuid(),
    userId: dbUserId,
    collection: opts.collection,
    key: opts.key,
    value: opts.value,
    valueType: opts.valueType,
    telegramMessageId: null,
    createdAt: now,
    updatedAt: now,
  }
  store.records.push(record)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  const payload: TelegramPayload = {
    owner: publicUserId,
    collection: opts.collection,
    key: opts.key,
    value: JSON.parse(opts.value),
    valueType: opts.valueType,
    updatedAt: Math.floor(Date.now() / 1000),
    op: 'SET',
  }
  void sendKvMessage(payload, chatId, botToken, botApiBaseUrl).then((msgId) => {
    if (msgId) {
      record.telegramMessageId = msgId
      saveToDisk()
    }
  })

  return { record, created: true }
}

export function deleteRecord(
  dbUserId: string,
  collection: string,
  key: string,
  chatId?: string,
  botToken?: string,
  botApiBaseUrl?: string,
): RecordEntry | null {
  const idx = store.records.findIndex(
    (r) => r.userId === dbUserId && r.collection === collection && r.key === key,
  )
  if (idx === -1) return null
  const [removed] = store.records.splice(idx, 1)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  if (removed.telegramMessageId) {
    void deleteKvMessage(removed.telegramMessageId, chatId, botToken, botApiBaseUrl)
  }
  return removed
}

export function listRecords(
  dbUserId: string,
  collection?: string,
): RecordEntry[] {
  return store.records
    .filter(
      (r) =>
        r.userId === dbUserId &&
        (collection === undefined || r.collection === collection),
    )
    .sort((a, b) => (a.key < b.key ? -1 : 1))
}

export function countRecords(dbUserId: string): number {
  return store.records.filter((r) => r.userId === dbUserId).length
}

// ─── Collection operations ───────────────────────────────────────────────────
//
// Collections are derived from records — BUT we also keep an explicit
// `collectionNames` list per user so that an empty collection (just created,
// no records yet) is still visible in the dashboard and selectable in the
// record-creation dropdown. Without this, "create collection" was a no-op
// and the new collection vanished as soon as the dialog closed.

export function listCollections(dbUserId: string): {
  name: string
  records: number
  createdAt: string
}[] {
  const byName = new Map<string, { records: number; createdAt: string }>()
  // 1. Records-derived collections (the source of truth for counts).
  for (const r of store.records) {
    if (r.userId !== dbUserId) continue
    const existing = byName.get(r.collection)
    if (existing) {
      existing.records++
      if (r.createdAt < existing.createdAt) existing.createdAt = r.createdAt
    } else {
      byName.set(r.collection, { records: 1, createdAt: r.createdAt })
    }
  }
  // 2. Explicitly-created collections (may have 0 records — they must still
  //    show up in the UI). Don't overwrite a records-derived entry's count.
  for (const c of store.collectionNames) {
    if (c.userId !== dbUserId) continue
    if (!byName.has(c.name)) {
      byName.set(c.name, { records: 0, createdAt: c.createdAt })
    }
  }
  return Array.from(byName.entries())
    .map(([name, info]) => ({ name, ...info }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

/**
 * Persist an explicitly-named collection so it shows up in the UI even before
 * any records are written to it. Idempotent — creating the same name twice is
 * a no-op. The special name `default` is reserved and rejected.
 *
 * Validates the name: 1–64 chars, `[a-zA-Z0-9_-]` only, must start with a
 * letter or underscore. Returns `{ ok: true }` on success or `{ error }` on
 * validation failure.
 */
export function createCollectionName(
  dbUserId: string,
  name: string,
): { ok: true } | { ok: false; error: string } {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: 'Collection name is required.' }
  if (trimmed.length > 64) return { ok: false, error: 'Collection name must be 64 characters or fewer.' }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(trimmed)) {
    return { ok: false, error: 'Collection name must start with a letter or underscore and contain only letters, digits, underscores, or hyphens.' }
  }
  if (trimmed === 'default') return { ok: false, error: 'The name "default" is reserved.' }
  // Idempotent: if the name already exists (explicit OR derived from records),
  // treat as success — the collection is already there.
  const existsExplicit = store.collectionNames.some(
    (c) => c.userId === dbUserId && c.name === trimmed,
  )
  const existsDerived = store.records.some(
    (r) => r.userId === dbUserId && r.collection === trimmed,
  )
  if (existsExplicit || existsDerived) return { ok: true }
  store.collectionNames.push({
    userId: dbUserId,
    name: trimmed,
    createdAt: new Date().toISOString(),
  })
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  return { ok: true }
}

/** Remove the explicit collection-name entry (used when deleting a collection). */
function removeCollectionName(dbUserId: string, name: string): void {
  store.collectionNames = store.collectionNames.filter(
    (c) => !(c.userId === dbUserId && c.name === name),
  )
}

export function countCollections(dbUserId: string): number {
  const names = new Set<string>()
  for (const r of store.records) if (r.userId === dbUserId) names.add(r.collection)
  for (const c of store.collectionNames) if (c.userId === dbUserId) names.add(c.name)
  return names.size
}

/**
 * Delete a collection: remove all its records (from the store AND from the
 * Telegram chat) and remove the explicit collection-name entry.
 *
 * Returns the number of records removed, or `null` if the collection doesn't
 * exist (neither in records nor in the explicit collectionNames list). This
 * distinguishes "found but empty" (0) from "not found" (null), so the route
 * can return the correct 404.
 */
export function deleteCollection(dbUserId: string, name: string, chatId?: string, botToken?: string, botApiBaseUrl?: string): number | null {
  const existsInRecords = store.records.some(
    (r) => r.userId === dbUserId && r.collection === name,
  )
  const existsInNames = store.collectionNames.some(
    (c) => c.userId === dbUserId && c.name === name,
  )
  if (!existsInRecords && !existsInNames) return null

  const toRemove = store.records.filter(
    (r) => r.userId === dbUserId && r.collection === name,
  )
  for (const r of toRemove) {
    if (r.telegramMessageId) void deleteKvMessage(r.telegramMessageId, chatId, botToken, botApiBaseUrl)
  }
  store.records = store.records.filter((r) => !(r.userId === dbUserId && r.collection === name))
  removeCollectionName(dbUserId, name)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  return toRemove.length
}

// ─── Log operations ──────────────────────────────────────────────────────────

export function addLog(opts: {
  dbUserId: string
  action: string
  key?: string | null
  detail?: string | null
  source?: string
  ip?: string | null
}): LogEntry {
  const entry: LogEntry = {
    id: cuid(),
    userId: opts.dbUserId,
    action: opts.action,
    key: opts.key ?? null,
    detail: opts.detail ?? null,
    source: opts.source ?? 'api',
    ip: opts.ip ?? null,
    createdAt: new Date().toISOString(),
  }
  store.logs.push(entry)
  // Cap logs at 1000 per user to avoid unbounded growth.
  const userLogs = store.logs.filter((l) => l.userId === opts.dbUserId)
  if (userLogs.length > 1000) {
    const keep = userLogs.slice(-1000).map((l) => l.id)
    store.logs = store.logs.filter((l) => l.userId !== opts.dbUserId || keep.includes(l.id))
  }
  saveToDisk()
  scheduleAccountSyncForDbUser(opts.dbUserId)
  return entry
}

export function listLogs(
  dbUserId: string,
  opts: { limit?: number; action?: string } = {},
): LogEntry[] {
  let items = store.logs.filter((l) => l.userId === dbUserId)
  if (opts.action) items = items.filter((l) => l.action === opts.action)
  items = items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  if (opts.limit) items = items.slice(0, opts.limit)
  return items
}

export function countLogs(dbUserId: string): number {
  return store.logs.filter((l) => l.userId === dbUserId).length
}

// ─── Stats ───────────────────────────────────────────────────────────────────

export function getStats(dbUserId: string) {
  const userRecords = store.records.filter((r) => r.userId === dbUserId)
  const userLogs = store.logs.filter((l) => l.userId === dbUserId)
  const userApiKeys = store.apiKeys.filter(
    (k) => k.userId === dbUserId && !k.revoked,
  )

  // 7-day activity
  const since = Date.now() - 6 * 24 * 60 * 60 * 1000
  const recentLogs = userLogs.filter(
    (l) => new Date(l.createdAt).getTime() >= since,
  )
  const activityByDay: Record<string, number> = {}
  const activityByAction: Record<string, number> = {}
  for (const l of recentLogs) {
    const day = l.createdAt.slice(0, 10)
    activityByDay[day] = (activityByDay[day] || 0) + 1
    activityByAction[l.action] = (activityByAction[l.action] || 0) + 1
  }

  const storageBytes = userRecords.reduce(
    (sum, r) => sum + r.value.length + r.key.length,
    0,
  )

  const collections = new Set(userRecords.map((r) => r.collection)).size

  const fileStats = countFiles(dbUserId)

  return {
    records: userRecords.length,
    collections,
    apiKeys: userApiKeys.length,
    logs: userLogs.length,
    storageBytes,
    files: fileStats.count,
    fileBytes: fileStats.bytes,
    activityByDay,
    activityByAction,
  }
}

export function getAnalytics(dbUserId: string) {
  const userRecords = store.records.filter((r) => r.userId === dbUserId)

  // By collection
  const byCollectionMap = new Map<string, number>()
  const byTypeMap = new Map<string, number>()
  for (const r of userRecords) {
    byCollectionMap.set(r.collection, (byCollectionMap.get(r.collection) || 0) + 1)
    byTypeMap.set(r.valueType, (byTypeMap.get(r.valueType) || 0) + 1)
  }

  // 14-day series + top keys
  const since = Date.now() - 13 * 24 * 60 * 60 * 1000
  const recentLogs = store.logs.filter(
    (l) => l.userId === dbUserId && new Date(l.createdAt).getTime() >= since,
  )
  const seriesMap: Record<string, number> = {}
  const topKeysMap: Record<string, number> = {}
  for (const l of recentLogs) {
    const day = l.createdAt.slice(0, 10)
    seriesMap[day] = (seriesMap[day] || 0) + 1
    if (l.key) topKeysMap[l.key] = (topKeysMap[l.key] || 0) + 1
  }

  return {
    byCollection: Array.from(byCollectionMap.entries())
      .map(([name, records]) => ({ name, records }))
      .sort((a, b) => b.records - a.records),
    byType: Array.from(byTypeMap.entries()).map(([type, count]) => ({ type, count })),
    series: Object.entries(seriesMap)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, count]) => ({ day, count })),
    topKeys: Object.entries(topKeysMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, count]) => ({ key, count })),
    totalEvents: recentLogs.length,
  }
}

// ─── Telegram config (per-user custom chat ID) ──────────────────────────────

/**
 * Get the Telegram config for a user. Returns the custom chat ID + label if
 * the user has set one, otherwise null (caller falls back to env default).
 */
export function getTelegramConfig(dbUserId: string): TelegramConfigRecord | null {
  if (!store.telegramConfigs) {
    store.telegramConfigs = []
    saveToDisk()
  }
  return store.telegramConfigs.find((c) => c.userId === dbUserId) ?? null
}

/**
 * Resolve the effective chat ID for a user: custom config if set, else env.
 * Returns '' if neither is configured.
 */
export function resolveChatId(dbUserId: string): string {
  const custom = getTelegramConfig(dbUserId)
  if (custom && custom.chatId.trim()) return custom.chatId.trim()
  return process.env.TELEGRAM_CHAT_ID || ''
}

/**
 * Resolve the effective bot token for a user: custom config if set, else env.
 * Returns '' if neither is configured.
 */
export function resolveBotToken(dbUserId: string): string {
  const custom = getTelegramConfig(dbUserId)
  if (custom && custom.botToken && custom.botToken.trim()) return custom.botToken.trim()
  return process.env.TELEGRAM_BOT_TOKEN || ''
}

/**
 * Whether a user has a FULL custom Telegram config — i.e. BOTH a custom chat
 * ID AND a custom bot token. Only a full custom config routes storage to the
 * user's own bot/chat; a partial config (chatId only, or token only) would mix
 * bots and chats and fail, so we treat it as "not set up" and fall back to the
 * server-side (env) Telegram storage automatically.
 */
export function hasCustomTelegramConfig(dbUserId: string): boolean {
  const c = getTelegramConfig(dbUserId)
  return Boolean(c && c.chatId.trim() && c.botToken && c.botToken.trim())
}

/**
 * Resolve the storage mode for a NEW upload:
 * - `'custom'` if the user has a full custom config (chatId + botToken).
 * - `'server'` otherwise — the operator's env Telegram bot is used.
 *
 * This is the "uploading to server-sided telegram storage automatically when
 * custom not set up" rule.
 */
export function resolveStorageMode(dbUserId: string): 'server' | 'custom' {
  return hasCustomTelegramConfig(dbUserId) ? 'custom' : 'server'
}

/**
 * Resolve the effective Bot API base URL for a user: custom config → env → '' (cloud default).
 * Returns '' when the cloud api.telegram.org is in use.
 */
export function resolveBotApiBaseUrl(dbUserId: string): string {
  const custom = getTelegramConfig(dbUserId)
  if (custom && custom.botApiBaseUrl && custom.botApiBaseUrl.trim()) return custom.botApiBaseUrl.trim()
  return process.env.TELEGRAM_BOT_API_URL || ''
}

/**
 * Resolve the Bot API base URL for an EXISTING file based on its stored
 * `botApiBaseUrl` (captured at upload time). Falls back to the user's current
 * config or env for legacy files uploaded before this field existed.
 */
export function resolveFileBotApiBaseUrl(file: FileRecord): string {
  // Prefer the URL stored on the file record (captured at upload time).
  if (file.botApiBaseUrl && file.botApiBaseUrl.trim()) return file.botApiBaseUrl.trim()
  // Legacy files (uploaded before this field existed) — infer from the user's
  // current config or env. This is best-effort: if the user had a local server
  // at upload time but removed it since, we can't know the original URL. The
  // file_id would be unresolvable in that case regardless.
  if (file.storageMode === 'custom') {
    const custom = getTelegramConfig(file.userId)
    if (custom && custom.botApiBaseUrl && custom.botApiBaseUrl.trim()) return custom.botApiBaseUrl.trim()
  }
  return process.env.TELEGRAM_BOT_API_URL || ''
}

/**
 * Resolve the chat ID for an EXISTING file based on its `storageMode` — NOT the
 * user's current config (which may have changed since upload). Files uploaded to
 * the server bot stay on the server bot; files uploaded to a custom bot stay on
 * that custom bot's chat (as long as the user still has a custom config; if
 * they removed it, the file is orphaned and we fall back to env to at least try
 * the delete).
 */
export function resolveFileChatId(file: FileRecord): string {
  if (file.storageMode === 'custom') {
    const custom = getTelegramConfig(file.userId)
    if (custom && custom.chatId.trim()) return custom.chatId.trim()
  }
  return process.env.TELEGRAM_CHAT_ID || ''
}

/**
 * Resolve the bot token for an EXISTING file based on its `storageMode`. A
 * Telegram file_id is bot-specific — it can ONLY be resolved by the bot that
 * originally received the document. So we MUST use the same bot that uploaded
 * the file, even if the user later configures a custom bot.
 */
export function resolveFileBotToken(file: FileRecord): string {
  if (file.storageMode === 'custom') {
    const custom = getTelegramConfig(file.userId)
    if (custom && custom.botToken && custom.botToken.trim()) return custom.botToken.trim()
  }
  return process.env.TELEGRAM_BOT_TOKEN || ''
}

/** Set or update the per-user Telegram chat ID, bot token, and/or local Bot API server URL. */
export function setTelegramConfig(
  dbUserId: string,
  chatId: string,
  label?: string | null,
  botToken?: string | null,
  botApiBaseUrl?: string | null,
): TelegramConfigRecord {
  const trimmed = chatId.trim()
  const trimmedToken = botToken?.trim() || null
  const trimmedUrl = botApiBaseUrl?.trim() || null
  const existing = store.telegramConfigs.find((c) => c.userId === dbUserId)
  const now = new Date().toISOString()
  let record: TelegramConfigRecord
  if (existing) {
    existing.chatId = trimmed
    existing.label = label ?? existing.label
    // Only overwrite the bot token if a new value is explicitly provided.
    // botToken === undefined means "don't touch the token"; botToken === null means "clear it".
    if (botToken !== undefined) {
      existing.botToken = trimmedToken
      existing.hasCustomBotToken = !!trimmedToken
    }
    // Same semantics for botApiBaseUrl: undefined = preserve, null = clear, string = set.
    if (botApiBaseUrl !== undefined) {
      existing.botApiBaseUrl = trimmedUrl
    }
    existing.updatedAt = now
    saveToDisk()
    record = existing
  } else {
    record = {
      userId: dbUserId,
      chatId: trimmed,
      label: label ?? null,
      botToken: trimmedToken,
      hasCustomBotToken: !!trimmedToken,
      botApiBaseUrl: trimmedUrl,
      updatedAt: now,
    }
    store.telegramConfigs.push(record)
    saveToDisk()
  }
  // V4: persist this account's manifest (now includes the updated telegramConfig).
  scheduleAccountSyncForDbUser(dbUserId)
  // Now that the user has a custom chat (+ optionally their own bot token),
  // push a per-user manifest to their chat so they can recover keys later.
  // Fire-and-forget — syncUserIdentityToTelegram is a no-op when the user
  // doesn't have BOTH a chat id and a custom bot token.
  void syncUserIdentityToTelegram(dbUserId)
  return record
}

/** Clear just the custom bot token (keep the chat ID). */
export function clearBotToken(dbUserId: string): boolean {
  const existing = store.telegramConfigs.find((c) => c.userId === dbUserId)
  if (!existing || !existing.hasCustomBotToken) return false
  existing.botToken = null
  existing.hasCustomBotToken = false
  existing.updatedAt = new Date().toISOString()
  saveToDisk()
  return true
}

/** Clear the per-user Telegram chat ID (revert to env default). */
export function clearTelegramConfig(dbUserId: string): boolean {
  const idx = store.telegramConfigs.findIndex((c) => c.userId === dbUserId)
  if (idx === -1) return false
  store.telegramConfigs.splice(idx, 1)
  saveToDisk()
  return true
}

// ─── Public share tokens (source-safe scoped credentials) ────────────────────

/** Generate a public share token: `st_<28 hex>`. */
export function generateShareToken(): string {
  return 'st_' + crypto.randomBytes(14).toString('hex').slice(0, 28)
}

/** In-memory per-IP rate-limit tracker: token -> { ip -> [timestamps] }. Not persisted. */
const shareRateBuckets = new Map<string, Map<string, number[]>>()

/**
 * Check the per-IP rate limit for a share token. Returns true if the request
 * is allowed (and records the hit), false if the limit is exceeded.
 */
function checkRateLimit(token: string, ip: string, limitPerMin: number | null): boolean {
  if (!limitPerMin || limitPerMin <= 0) return true // unlimited
  const now = Date.now()
  const windowMs = 60_000
  let ipMap = shareRateBuckets.get(token)
  if (!ipMap) {
    ipMap = new Map()
    shareRateBuckets.set(token, ipMap)
  }
  let hits = ipMap.get(ip) ?? []
  // Drop entries older than the 60s window.
  hits = hits.filter((t) => now - t < windowMs)
  if (hits.length >= limitPerMin) {
    ipMap.set(ip, hits)
    return false
  }
  hits.push(now)
  ipMap.set(ip, hits)
  return true
}

export interface CreateShareTokenOpts {
  dbUserId: string
  collection: string
  key: string
  mode: 'read' | 'write' | 'readwrite'
  label?: string | null
  /** Minutes until expiry; null/0 = never. */
  ttlMinutes?: number | null
  rateLimitPerMin?: number | null
  allowedOps?: ('set' | 'incr' | 'append')[]
  maxValueLength?: number | null
  incrMin?: number | null
  incrMax?: number | null
}

export function createShareToken(opts: CreateShareTokenOpts): ShareTokenRecord {
  const now = new Date().toISOString()
  const expiresAt =
    opts.ttlMinutes && opts.ttlMinutes > 0
      ? new Date(Date.now() + opts.ttlMinutes * 60_000).toISOString()
      : null
  const record: ShareTokenRecord = {
    id: cuid(),
    token: generateShareToken(),
    userId: opts.dbUserId,
    collection: opts.collection || 'default',
    key: opts.key,
    mode: opts.mode,
    label: opts.label?.trim() || null,
    expiresAt,
    rateLimitPerMin: opts.rateLimitPerMin ?? null,
    allowedOps: opts.allowedOps && opts.allowedOps.length > 0 ? opts.allowedOps : ['set', 'incr', 'append'],
    maxValueLength: opts.maxValueLength ?? null,
    incrMin: opts.incrMin ?? null,
    incrMax: opts.incrMax ?? null,
    createdAt: now,
    lastUsedAt: null,
    revoked: false,
  }
  store.shareTokens.push(record)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  return record
}

export function listShareTokens(dbUserId: string): ShareTokenRecord[] {
  return store.shareTokens
    .filter((t) => t.userId === dbUserId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export function findShareToken(token: string): ShareTokenRecord | undefined {
  return store.shareTokens.find((t) => t.token === token && !t.revoked)
}

export function findShareTokenById(dbUserId: string, id: string): ShareTokenRecord | undefined {
  return store.shareTokens.find((t) => t.id === id && t.userId === dbUserId)
}

export function revokeShareToken(dbUserId: string, id: string): ShareTokenRecord | null {
  const t = store.shareTokens.find((t) => t.id === id && t.userId === dbUserId)
  if (!t) return null
  t.revoked = true
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  return t
}

/**
 * Validate + consume a share-token request. Returns either the token record
 * (valid, allowed) or a reason string for the caller to turn into an HTTP error.
 *
 * Checks: existence, revocation, expiry, mode permission, rate limit.
 * Mutates lastUsedAt on success.
 */
export function resolveShareToken(
  token: string,
  ip: string,
  requiredMode: 'read' | 'write',
): { ok: true; record: ShareTokenRecord } | { ok: false; reason: string; status: number } {
  const rec = store.shareTokens.find((t) => t.token === token)
  if (!rec || rec.revoked) {
    return { ok: false, reason: 'Invalid or revoked share token.', status: 404 }
  }
  if (rec.expiresAt && new Date(rec.expiresAt).getTime() < Date.now()) {
    return { ok: false, reason: 'This share token has expired.', status: 410 }
  }
  const canRead = rec.mode === 'read' || rec.mode === 'readwrite'
  const canWrite = rec.mode === 'write' || rec.mode === 'readwrite'
  if (requiredMode === 'read' && !canRead) {
    return { ok: false, reason: 'This token is write-only.', status: 403 }
  }
  if (requiredMode === 'write' && !canWrite) {
    return { ok: false, reason: 'This token is read-only.', status: 403 }
  }
  if (!checkRateLimit(rec.token, ip, rec.rateLimitPerMin)) {
    return {
      ok: false,
      reason: `Rate limit exceeded (${rec.rateLimitPerMin} req/min). Try again shortly.`,
      status: 429,
    }
  }
  rec.lastUsedAt = new Date().toISOString()
  saveToDisk()
  return { ok: true, record: rec }
}

/** Public-safe projection of a share token (never leaks beyond what's needed). */
export function publicShareTokenView(t: ShareTokenRecord, origin: string) {
  return {
    id: t.id,
    token: t.token,
    collection: t.collection,
    key: t.key,
    mode: t.mode,
    label: t.label,
    expiresAt: t.expiresAt,
    rateLimitPerMin: t.rateLimitPerMin,
    allowedOps: t.allowedOps,
    maxValueLength: t.maxValueLength,
    incrMin: t.incrMin,
    incrMax: t.incrMax,
    createdAt: t.createdAt,
    lastUsedAt: t.lastUsedAt,
    revoked: t.revoked,
    readUrl: `${origin}/v1/share/${t.token}`,
    writeUrl: `${origin}/v1/write/${t.token}`,
  }
}

// ─── File storage (documents up to 2 GB, any extension) ──────────────────────
//
// Files live as Telegram document messages. We keep a local FileRecord index
// with the Telegram file_id (stable) so the public download proxy can call
// `getFile` to resolve a fresh temporary URL and stream the bytes back. The
// Telegram download URL itself is NEVER exposed to end users — only the
// permanent `/f/<fileId>` link is.

/** Generate a public, unguessable file id: `f_<28 hex>`. */
export function generatePublicFileId(): string {
  return 'f_' + crypto.randomBytes(14).toString('hex').slice(0, 28)
}

/** Hard upper bound on a single upload: 2 GiB (Telegram's absolute ceiling). */
export const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024

/**
 * Persist a file record AFTER the Telegram upload succeeded. The caller is
 * responsible for uploading via `sendDocumentFile` and passing the returned
 * SentDocument. Returns the stored record.
 */
export function createFileRecord(
  dbUserId: string,
  opts: {
    sent: SentDocument
    fileName: string
    mimeType: string
    size: number
    label?: string | null
    isPublic?: boolean
    /** Which Telegram backend was used — 'server' (env) or 'custom' (user's own). */
    storageMode?: 'server' | 'custom'
    /** The Bot API base URL used at upload time (null/empty = cloud api.telegram.org). */
    botApiBaseUrl?: string | null
  },
): FileRecord {
  const now = new Date().toISOString()
  const record: FileRecord = {
    id: cuid(),
    fileId: generatePublicFileId(),
    userId: dbUserId,
    fileName: opts.fileName,
    mimeType: opts.mimeType || 'application/octet-stream',
    size: opts.size,
    telegramMessageId: opts.sent.messageId,
    telegramFileId: opts.sent.fileId,
    telegramFileUniqueId: opts.sent.fileUniqueId,
    storageMode: opts.storageMode ?? 'server',
    botApiBaseUrl: opts.botApiBaseUrl?.trim() || null,
    label: opts.label?.trim() || null,
    isPublic: opts.isPublic ?? true,
    downloads: 0,
    linkRevokedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  store.files.push(record)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  return record
}

/** List all files owned by a user, newest first. */
export function listFileRecords(dbUserId: string): FileRecord[] {
  return store.files
    .filter((f) => f.userId === dbUserId)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Find a file by its public file id (used by the download proxy — no auth). */
export function findFileByPublicId(fileId: string): FileRecord | undefined {
  return store.files.find((f) => f.fileId === fileId)
}

/** Find a file by its internal id, scoped to the owner (used by the dashboard). */
export function findFileById(dbUserId: string, id: string): FileRecord | undefined {
  return store.files.find((f) => f.id === id && f.userId === dbUserId)
}

/**
 * Delete a file: remove the Telegram message (best-effort) and drop the local
 * record. Returns the removed record, or null if not found / not owned.
 *
 * The chatId + botToken are resolved from the FILE's `storageMode` (not the
 * user's current config) — this is critical because the Telegram message lives
 * in whichever bot/chat received the upload, which may differ from the user's
 * current settings if they changed (or removed) their custom config after
 * uploading.
 */
export function deleteFileRecord(dbUserId: string, id: string): FileRecord | null {
  const idx = store.files.findIndex((f) => f.id === id && f.userId === dbUserId)
  if (idx === -1) return null
  const [removed] = store.files.splice(idx, 1)
  saveToDisk()
  scheduleAccountSyncForDbUser(dbUserId)
  if (removed.telegramMessageId) {
    const chatId = resolveFileChatId(removed)
    const botToken = resolveFileBotToken(removed)
    const botApiBaseUrl = resolveFileBotApiBaseUrl(removed)
    void deleteFileMessage(removed.telegramMessageId, chatId, botToken, botApiBaseUrl)
  }
  return removed
}

/** Increment the download counter for a file (fire-and-forget save). */
export function incrementFileDownload(fileId: string): void {
  const f = store.files.find((x) => x.fileId === fileId)
  if (!f) return
  f.downloads++
  f.updatedAt = new Date().toISOString()
  saveToDisk()
}

/**
 * Mark a file's most-recently-minted Telegram download URL as revoked. This
 * drops our server-side cache for that URL (so we never re-serve it) and
 * records a `linkRevokedAt` timestamp on the record.
 *
 * IMPORTANT: Telegram's `getFile` URLs cannot be manually revoked — they
 * expire naturally ~1 hour after being minted. "Revoke" here means we stop
 * caching and re-serving the URL on our side; the underlying Telegram URL
 * remains valid until Telegram's own 1-hour timer runs out. The next
 * "Get link" call will mint a BRAND-NEW URL (a fresh `getFile` call).
 *
 * Returns the updated file (or null if not found / not owned).
 */
export function markFileLinkRevoked(dbUserId: string, id: string): FileRecord | null {
  const f = store.files.find((x) => x.id === id && x.userId === dbUserId)
  if (!f) return null
  f.linkRevokedAt = Date.now()
  f.updatedAt = new Date().toISOString()
  saveToDisk()
  return f
}

/** Count + total bytes for a user's files (used by the dashboard stats). */
export function countFiles(dbUserId: string): { count: number; bytes: number } {
  const userFiles = store.files.filter((f) => f.userId === dbUserId)
  return {
    count: userFiles.length,
    bytes: userFiles.reduce((sum, f) => sum + (f.size || 0), 0),
  }
}

/**
 * Upload a file to the user's effective Telegram chat and persist a FileRecord.
 * This is the single entry point used by both the dashboard and the REST API.
 * ALL file extensions are accepted (the OS / Telegram decide what's storable).
 */
export async function uploadFile(
  dbUserId: string,
  payload: {
    file: Blob
    fileName: string
    mimeType: string
    size: number
    label?: string | null
    isPublic?: boolean
  },
): Promise<{ record: FileRecord } | { error: string }> {
  if (payload.size <= 0) return { error: 'File is empty.' }
  // ─── Storage routing: the "server-sided telegram storage automatically when
  // custom not set up" rule. ────────────────────────────────────────────────
  //
  // - If the user has a FULL custom config (both chatId AND botToken), we use
  //   THEIR own Telegram bot + chat → `storageMode = 'custom'`.
  // - Otherwise (no custom config, OR a partial one that can't work), we fall
  //   back to the operator's env-configured Telegram bot + chat →
  //   `storageMode = 'server'`. This is the automatic default.
  //
  // We never mix a custom chatId with the env bot token (or vice-versa) — that
  // would always fail because the env bot isn't a member of the user's chat.
  const storageMode = resolveStorageMode(dbUserId)
  let chatId: string
  let botToken: string
  let botApiBaseUrl: string
  if (storageMode === 'custom') {
    const custom = getTelegramConfig(dbUserId)!
    chatId = custom.chatId.trim()
    botToken = custom.botToken!.trim()
    botApiBaseUrl = custom.botApiBaseUrl?.trim() || ''
  } else {
    chatId = process.env.TELEGRAM_CHAT_ID || ''
    botToken = process.env.TELEGRAM_BOT_TOKEN || ''
    botApiBaseUrl = process.env.TELEGRAM_BOT_API_URL || ''
  }
  if (!chatId || !botToken) {
    return {
      error:
        storageMode === 'custom'
          ? 'Your custom Telegram configuration is incomplete — set BOTH a Chat ID and a Bot Token in Settings, or clear them to use the server-side storage automatically.'
          : 'Telegram storage is not available. The server operator has not configured the server-side Telegram bot, and you have not set up a custom Bot Token + Chat ID in Settings.',
    }
  }
  // ─── Size-limit enforcement (BEFORE hitting Telegram) ─────────────────────
  // The cloud Bot API caps uploads at 50 MB; a local Bot API server raises that
  // to 2 GB. Enforce the right limit here so the user gets a clear, actionable
  // error message instead of a confusing Telegram rejection.
  const maxBytes = botApiBaseUrl ? LOCAL_BOT_API_LIMIT_BYTES : CLOUD_UPLOAD_LIMIT_BYTES
  if (payload.size > maxBytes) {
    const hint = botApiBaseUrl
      ? 'The file exceeds the 2 GB local Bot API server limit.'
      : 'The file exceeds the 50 MB cloud Bot API upload limit. To upload files up to 2 GB, configure a custom local Bot API server URL in Settings → Telegram chat ID.'
    return { error: `File is ${(payload.size / 1024 / 1024).toFixed(1)} MB — ${hint}` }
  }
  const sent = await sendDocumentFile(
    {
      file: payload.file,
      fileName: payload.fileName,
      mimeType: payload.mimeType,
      caption: payload.label ? payload.label.slice(0, 200) : undefined,
    },
    chatId,
    botToken,
    botApiBaseUrl,
  )
  if (!sent.ok) {
    // Surface the ACTUAL Telegram error (e.g. "Unauthorized", "chat not found")
    // — NOT a misleading "50 MB limit" guess.
    return { error: sent.error }
  }
  const record = createFileRecord(dbUserId, {
    sent: sent.document,
    fileName: payload.fileName,
    mimeType: payload.mimeType,
    size: payload.size,
    label: payload.label,
    isPublic: payload.isPublic,
    storageMode,
    botApiBaseUrl,
  })
  return { record }
}

/** Public-safe projection of a file for the dashboard / API list. */
export function fileView(f: FileRecord, origin: string) {
  return {
    id: f.id,
    fileId: f.fileId,
    fileName: f.fileName,
    mimeType: f.mimeType,
    size: f.size,
    storageMode: f.storageMode ?? 'server',
    /** Whether the file was uploaded via a local Bot API server (null/empty = cloud). */
    botApiBaseUrl: f.botApiBaseUrl ?? null,
    label: f.label,
    isPublic: f.isPublic,
    downloads: f.downloads,
    linkRevokedAt: f.linkRevokedAt ?? null,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    downloadUrl: `${origin}/f/${f.fileId}`,
  }
}

// ─── Admin operations ────────────────────────────────────────────────────────

/** Ensure the virtual admin user exists (so admin can use the regular app). */
function ensureAdminUser(): UserRecord {
  let admin = store.users.find((u) => u.id === ADMIN_DB_USER_ID)
  if (!admin) {
    admin = {
      id: ADMIN_DB_USER_ID,
      userId: ADMIN_PUBLIC_USER_ID,
      name: 'Administrator',
      email: null,
      passwordHash: null,
      plan: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    store.users.push(admin)
    saveToDisk()
  }
  return admin
}

/**
 * Seed the bootstrap admin key (idempotent).
 *
 * SECURITY: Skipped entirely when the operator has not set
 * `BOOTSTRAP_ADMIN_KEY` in `.env` — we never want an empty-string admin key
 * sitting in the store. The admin app will simply show "no admin key
 * configured" until the operator adds one.
 */
function seedBootstrapAdminKey() {
  if (!BOOTSTRAP_ADMIN_KEY_CONFIGURED) return
  if (!store.adminKeys.some((k) => k.key === BOOTSTRAP_ADMIN_KEY)) {
    store.adminKeys.push({
      id: 'admin_bootstrap',
      key: BOOTSTRAP_ADMIN_KEY,
      label: 'Bootstrap Admin',
      createdAt: new Date().toISOString(),
      createdBy: 'bootstrap',
      promotedFromUserId: null,
      promotedFromUserEmail: null,
      revoked: false,
    })
    saveToDisk()
  }
}

/** Look up an admin key by its full token string. Returns null if not found / revoked. */
export function findAdminKey(key: string): AdminKeyRecord | null {
  const adminKey = store.adminKeys.find((k) => k.key === key && !k.revoked)
  return adminKey ?? null
}

/** Check whether a token string is an admin key (starts with `onyxbase_`). */
export function isAdminKey(token: string): boolean {
  return token.startsWith('onyxbase_')
}

/** Ensure the admin user exists and return it (for authenticate()). */
export function getOrCreateAdminUser(): UserRecord {
  return ensureAdminUser()
}

/** List ALL users (excluding the virtual admin) with summary stats for the admin dashboard. */
export function adminListAllUsers() {
  return store.users
    .filter((u) => u.id !== ADMIN_DB_USER_ID)
    .map((u) => {
      const apiKeys = store.apiKeys.filter((k) => k.userId === u.id)
      const records = store.records.filter((r) => r.userId === u.id)
      const files = store.files.filter((f) => f.userId === u.id)
      const collections = listCollections(u.id)
      return {
        id: u.id,
        userId: u.userId,
        name: u.name,
        email: u.email,
        plan: u.plan,
        createdAt: u.createdAt,
        stats: {
          apiKeys: apiKeys.length,
          activeApiKeys: apiKeys.filter((k) => !k.revoked).length,
          records: records.length,
          collections: collections.length,
          files: files.length,
          fileBytes: files.reduce((s, f) => s + f.size, 0),
        },
      }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Get a single user's full data (collections, records, files, api keys) for the admin dashboard. */
export function adminGetUserDetail(dbUserId: string) {
  const user = store.users.find((u) => u.id === dbUserId)
  if (!user) return null
  const apiKeys = listApiKeys(dbUserId)
  const records = listRecords(dbUserId, undefined)
  const files = listFileRecords(dbUserId)
  const collections = listCollections(dbUserId)
  const telegramConfig = getTelegramConfig(dbUserId)
  return {
    user: {
      id: user.id,
      userId: user.userId,
      name: user.name,
      email: user.email,
      plan: user.plan,
      createdAt: user.createdAt,
    },
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      name: k.name,
      keyPrefix: k.key.slice(0, 12) + '…',
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revoked: k.revoked,
    })),
    records: records.map((r) => ({
      id: r.id,
      collection: r.collection,
      key: r.key,
      value: r.value,
      valueType: r.valueType,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    })),
    files: files.map((f) => ({
      id: f.id,
      fileId: f.fileId,
      fileName: f.fileName,
      mimeType: f.mimeType,
      size: f.size,
      isPublic: f.isPublic,
      downloads: f.downloads,
      storageMode: f.storageMode ?? 'server',
      label: f.label,
      createdAt: f.createdAt,
    })),
    collections: collections.map((c) => ({
      name: c.name,
      count: c.count,
      createdAt: c.createdAt,
    })),
    telegramConfig: telegramConfig
      ? {
          chatId: telegramConfig.chatId,
          label: telegramConfig.label,
          hasCustomBotToken: telegramConfig.hasCustomBotToken,
        }
      : null,
  }
}

/** List ALL files across ALL users (for the admin file browser). */
export function adminListAllFiles() {
  return store.files
    .filter((f) => f.userId !== ADMIN_DB_USER_ID)
    .map((f) => {
      const user = store.users.find((u) => u.id === f.userId)
      return {
        id: f.id,
        fileId: f.fileId,
        fileName: f.fileName,
        mimeType: f.mimeType,
        size: f.size,
        isPublic: f.isPublic,
        downloads: f.downloads,
        storageMode: f.storageMode ?? 'server',
        label: f.label,
        createdAt: f.createdAt,
        owner: {
          id: f.userId,
          userId: user?.userId ?? '?',
          name: user?.name ?? null,
          email: user?.email ?? null,
        },
      }
    })
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Find any file by id (admin override — works across all users). */
export function adminFindFileById(id: string): FileRecord | null {
  return store.files.find((f) => f.id === id) ?? null
}

/** Get aggregate stats across ALL users for the admin dashboard. */
export function adminGetGlobalStats() {
  const realUsers = store.users.filter((u) => u.id !== ADMIN_DB_USER_ID)
  const realFiles = store.files.filter((f) => f.userId !== ADMIN_DB_USER_ID)
  const realRecords = store.records.filter((r) => r.userId !== ADMIN_DB_USER_ID)
  const realApiKeys = store.apiKeys.filter((k) => k.userId !== ADMIN_DB_USER_ID)
  return {
    users: realUsers.length,
    records: realRecords.length,
    files: realFiles.length,
    fileBytes: realFiles.reduce((s, f) => s + f.size, 0),
    apiKeys: realApiKeys.length,
    activeApiKeys: realApiKeys.filter((k) => !k.revoked).length,
    collections: new Set(realRecords.map((r) => r.collection)).size,
    adminKeys: store.adminKeys.length,
  }
}

/**
 * Promote a regular user (identified by their kv_live API key) to admin.
 * Mints a new `onyxbase_<hex>` key for them. Returns null if the kv_live key
 * is invalid or revoked.
 */
export function adminPromoteUser(kvLiveKey: string, label?: string): AdminKeyRecord | null {
  const apiKey = store.apiKeys.find((k) => k.key === kvLiveKey && !k.revoked)
  if (!apiKey) return null
  const user = store.users.find((u) => u.id === apiKey.userId)
  if (!user) return null

  const newKey = `onyxbase_${crypto.randomBytes(8).toString('hex')}`
  const adminKey: AdminKeyRecord = {
    id: cuid(),
    key: newKey,
    label: label?.trim() || `Promoted from ${user.email ?? user.userId}`,
    createdAt: new Date().toISOString(),
    createdBy: 'promoted',
    promotedFromUserId: user.id,
    promotedFromUserEmail: user.email,
    revoked: false,
  }
  store.adminKeys.push(adminKey)
  saveToDisk()
  // V4: adminKeys live in the __system__ account manifest.
  scheduleAccountSync(SYSTEM_ACCOUNT_ID)
  return adminKey
}

/** List all admin keys (with sensitive fields redacted for display). */
export function adminListAdminKeys() {
  return store.adminKeys
    .map((k) => ({
      id: k.id,
      key: k.key,
      label: k.label,
      createdAt: k.createdAt,
      createdBy: k.createdBy,
      promotedFromUserEmail: k.promotedFromUserEmail,
      isBootstrap: k.key === BOOTSTRAP_ADMIN_KEY,
      revoked: k.revoked,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

/** Revoke an admin key (the bootstrap key cannot be revoked). */
export function adminRevokeAdminKey(id: string): AdminKeyRecord | null {
  const k = store.adminKeys.find((x) => x.id === id && x.key !== BOOTSTRAP_ADMIN_KEY)
  if (!k) return null
  k.revoked = true
  saveToDisk()
  // V4: adminKeys live in the __system__ account manifest.
  scheduleAccountSync(SYSTEM_ACCOUNT_ID)
  return k
}

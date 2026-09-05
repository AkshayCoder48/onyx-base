/**
 * Onyx Base — named MCPEmail credential store (Email Automation PRD §3–§5, §14).
 *
 * ARCHITECTURE (privacy-first credential ownership):
 *
 *   USER ── owns ──> named credentials (personal_email, work_email, …)
 *                     │  stored as records in the USER'S OWN account
 *                     │  (collection `__email_credentials__`, key = name)
 *                     ▼
 *          cloudkv.json + Telegram pinned manifest mirror  ← the private
 *                     │                                        credential bridge
 *                     ▼
 *          POST /api/email/send { "credential": "personal_email", … }
 *                     │  authenticated with the PLATFORM API key (kv_live_*)
 *                     ▼
 *          credential resolver → the USER'S mcpe_* key (NEVER a project key)
 *                     ▼
 *          MCPEmail upstream (mcpemails.com)
 *
 * CRITICAL RULES enforced here:
 *   1. Two DIFFERENT credentials exist and must never be confused:
 *      - Platform API key (kv_live_*) → authenticates user → OUR API. It is
 *        NEVER forwarded to MCPEmail.
 *      - MCPEmail key (mcpe_*) → resolved by name from THIS store and used
 *        ONLY for the OUR-API → MCPEmail hop.
 *   2. FAIL CLOSED: if the requested credential name does not exist for the
 *      caller, we return `credential_not_found`. There is NO fallback to any
 *      project-wide MCPEmail key — anywhere, ever.
 *   3. Credentials are tenant-scoped: user A can never resolve user B's
 *      credential (records are keyed by dbUserId).
 *   4. The raw key is returned ONLY to server-side callers (the orchestrator).
 *      API responses always carry the masked view (`mcpe_4c7b1e9a…1f3a`).
 *
 * Each credential carries a CUSTOM RATE LIMIT for the MCPEmail forwarding
 * layer (`rateLimitPerMin`, PRD: "setting custom rate limits on MCPEmail
 * service"). null = unlimited (still capped by the platform-level per-key and
 * per-IP limiters in the send route).
 *
 * Legacy migration (PRD §32, controlled migration): users of the retired
 * Email OTP system have a single config under collection `__mcpemail__`,
 * key `config`. On first access, if the user has no named credentials yet
 * but DOES have a legacy config, it is migrated into a credential named
 * `default` (the user's OWN key — not a project key — so this is a
 * user-scoped migration, not a project-wide fallback).
 */

import { upsertRecord, findRecord, deleteRecord, listRecords } from '@/lib/data-store'
import { isValidMcpeKey, maskMcpeKey, getRawMcpeConfig } from '@/lib/mcpemail-config'

const COLLECTION = '__email_credentials__'
const LEGACY_COLLECTION = '__mcpemail__'
const LEGACY_KEY = 'config'
const MIGRATED_NAME = 'default'

/** Max credentials per user — keeps the manifest small. */
export const MAX_CREDENTIALS = 20

/** Credential name rules: 1–64 chars, starts alnum/underscore, then [A-Za-z0-9_-]. */
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/

export function isValidCredentialName(name: string): boolean {
  return NAME_RE.test(name)
}

export function credentialNameError(name: string): string {
  return `Credential name "${name}" is invalid. Use 1–64 characters: letters, digits, "_" or "-", starting with a letter/digit/underscore (e.g. personal_email).`
}

export interface EmailCredentialValue {
  /** Raw MCPEmails API key — server-side only, never returned to clients. */
  apiKey: string
  /** Optional human label. */
  label: string | null
  /** Optional sender display name forwarded to MCPEmails. */
  fromName: string | null
  /**
   * Custom rate limit for MCPEmail sends through this credential
   * (requests/minute, enforced before the upstream call). null = unlimited.
   */
  rateLimitPerMin: number | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

/** Masked view — the ONLY shape ever serialized to an API response. */
export interface EmailCredentialPublicView {
  name: string
  apiKeyMasked: string
  label: string | null
  fromName: string | null
  rateLimitPerMin: number | null
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
}

function toView(name: string, value: EmailCredentialValue): EmailCredentialPublicView {
  return {
    name,
    apiKeyMasked: maskMcpeKey(value.apiKey),
    label: value.label,
    fromName: value.fromName,
    rateLimitPerMin: value.rateLimitPerMin,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastUsedAt: value.lastUsedAt,
  }
}

function parseValue(raw: string): EmailCredentialValue | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EmailCredentialValue>
    if (!parsed || typeof parsed.apiKey !== 'string' || !parsed.apiKey) return null
    return {
      apiKey: parsed.apiKey,
      label: parsed.label ?? null,
      fromName: parsed.fromName ?? null,
      rateLimitPerMin:
        typeof parsed.rateLimitPerMin === 'number' && parsed.rateLimitPerMin > 0
          ? Math.floor(parsed.rateLimitPerMin)
          : null,
      createdAt: parsed.createdAt ?? new Date().toISOString(),
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
      lastUsedAt: parsed.lastUsedAt ?? null,
    }
  } catch {
    return null
  }
}

/**
 * One-time migration of the legacy single-config (Email OTP era) into a
 * named credential `default`. Runs lazily: only when the user has NO named
 * credentials yet but has a legacy `__mcpemail__/config` record. The legacy
 * record is DELETED after conversion — a clean, one-way migration (this also
 * prevents a deleted credential from resurrecting from the stale legacy
 * record). Rollback = simply reconnect the key via the new credentials API.
 */
function migrateLegacyConfig(dbUserId: string, publicUserId: string): void {
  const existing = listRecords(dbUserId, COLLECTION)
  if (existing.length > 0) return // already migrated or user created credentials
  const legacy = getRawMcpeConfig(dbUserId)
  if (!legacy) return
  const now = new Date().toISOString()
  const value: EmailCredentialValue = {
    apiKey: legacy.apiKey,
    label: legacy.label ?? 'Migrated from Email OTP config',
    fromName: legacy.fromName,
    rateLimitPerMin: null,
    createdAt: now,
    updatedAt: now,
    lastUsedAt: null,
  }
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: MIGRATED_NAME,
    value: JSON.stringify(value),
    valueType: 'object',
  })
  // Remove the legacy record so it can never resurrect or diverge.
  deleteRecord(dbUserId, LEGACY_COLLECTION, LEGACY_KEY)
}

/** List the user's credentials as masked views (migrating legacy first). */
export function listCredentialViews(dbUserId: string, publicUserId: string): EmailCredentialPublicView[] {
  migrateLegacyConfig(dbUserId, publicUserId)
  return listRecords(dbUserId, COLLECTION)
    .map((rec) => {
      const value = parseValue(rec.value)
      return value ? toView(rec.key, value) : null
    })
    .filter((v): v is EmailCredentialPublicView => v !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** Get the RAW credential by name — server-side orchestrator use ONLY. */
export function getRawCredential(
  dbUserId: string,
  name: string,
): { name: string; value: EmailCredentialValue } | null {
  const rec = findRecord(dbUserId, COLLECTION, name)
  if (!rec) return null
  const value = parseValue(rec.value)
  if (!value) return null
  return { name, value }
}

/** Get one masked view by name (API responses). */
export function getCredentialView(
  dbUserId: string,
  publicUserId: string,
  name: string,
): EmailCredentialPublicView | null {
  migrateLegacyConfig(dbUserId, publicUserId)
  const raw = getRawCredential(dbUserId, name)
  return raw ? toView(raw.name, raw.value) : null
}

export interface SaveCredentialOpts {
  name: string
  apiKey: string
  label?: string | null
  fromName?: string | null
  rateLimitPerMin?: number | null
}

/**
 * Create or update a named credential. Validates name + key format.
 * Throws Error with a human-readable message on validation failure.
 * Returns the masked view (never the raw key).
 */
export function saveCredential(
  dbUserId: string,
  publicUserId: string,
  opts: SaveCredentialOpts,
): EmailCredentialPublicView {
  const name = opts.name.trim()
  if (!isValidCredentialName(name)) throw new Error(credentialNameError(name))

  const apiKey = opts.apiKey.trim()
  if (!isValidMcpeKey(apiKey)) {
    throw new Error(
      'MCPEmail API key must start with "mcpe_" and be at least 25 characters (e.g. mcpe_4c7b1e9a0d5f…).',
    )
  }

  let rateLimitPerMin: number | null = null
  if (opts.rateLimitPerMin != null) {
    const n = Number(opts.rateLimitPerMin)
    if (!Number.isFinite(n) || n < 1 || n > 10000) {
      throw new Error('Rate limit must be between 1 and 10000 requests/minute, or null to disable.')
    }
    rateLimitPerMin = Math.floor(n)
  }

  const existing = getRawCredential(dbUserId, name)
  const now = new Date().toISOString()
  const value: EmailCredentialValue = {
    apiKey,
    label: opts.label?.trim() || null,
    fromName: opts.fromName?.trim() || null,
    rateLimitPerMin,
    createdAt: existing?.value.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: existing?.value.lastUsedAt ?? null,
  }
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: name,
    value: JSON.stringify(value),
    valueType: 'object',
  })
  return toView(name, value)
}

/** Delete a named credential. Returns true when a record was removed. */
export function deleteCredential(dbUserId: string, name: string): boolean {
  const removed = deleteRecord(dbUserId, COLLECTION, name)
  return removed !== null
}

/** Touch lastUsedAt after a send (fire-and-forget metadata update). */
export function touchCredentialLastUsed(dbUserId: string, publicUserId: string, name: string): void {
  const raw = getRawCredential(dbUserId, name)
  if (!raw) return
  raw.value.lastUsedAt = new Date().toISOString()
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: name,
    value: JSON.stringify(raw.value),
    valueType: 'object',
  })
}

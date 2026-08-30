/**
 * Onyx Base — MCPEmail per-user config storage.
 *
 * Stored as a regular record in the user's account so it rides the existing
 * persistence pipeline (cloudkv.json + Telegram manifest mirror + cold-boot
 * rehydrate). This means:
 *   - Zero changes to StoreShape / EMPTY_STORE / loadStore / serialize.
 *   - The user's MCPEmail API key survives Vercel cold boots.
 *   - The dashboard shows the config as one record under collection
 *     `__mcpemail__` with key `config` — transparent, no hidden state.
 *
 * Security model: the value stored on disk (cloudkv.json) and in the
 * Telegram mirror contains the raw `mcpe_*` key. The dashboard GET
 * endpoint returns a MASKED version (e.g. `mcpe_live_AbCd…` or
 * `mcpe_4c7b1e9aAbCd…`) so the key is never re-exposed to the browser after
 * saving — same posture as the Telegram bot token in `telegram-config`.
 *
 * The send/verify endpoints read the raw key server-side directly from
 * the record — they never go through this mask.
 */

import { upsertRecord, findRecord, deleteRecord } from '@/lib/data-store'

const COLLECTION = '__mcpemail__'
const KEY = 'config'

export interface McpeConfigValue {
  /** Raw MCPEmails API key, e.g. `mcpe_live_AbCdEf...` or `mcpe_4c7b1e9aAbCd...`. */
  apiKey: string
  /** Optional human label for the dashboard. */
  label: string | null
  /** Optional sender display name (passed as `fromName` to MCPEmails). */
  fromName: string | null
  /** Optional subject template. `$CODE` is replaced with the OTP. */
  subjectTemplate: string | null
  /** Optional body template. `$CODE` is replaced with the OTP. */
  bodyTemplate: string | null
  updatedAt: string
}

export interface McpeConfigPublicView {
  hasConfig: boolean
  /** Masked key, e.g. `mcpe_live_AbCd…` or `mcpe_4c7b1e9aAbCd…`. Never the raw key. */
  apiKeyMasked: string
  label: string | null
  fromName: string | null
  subjectTemplate: string | null
  bodyTemplate: string | null
  updatedAt: string | null
}

const DEFAULT_SUBJECT = 'Your verification code'
const DEFAULT_BODY =
  'Your Onyx Base verification code is $CODE.\n\nIt expires in 10 minutes. If you did not request this code, you can ignore this email.'

/**
 * Validate an MCPEmails API key.
 *
 * MCPEmails has issued multiple key families over time:
 *   - `mcpe_live_*` — the original live keys (e.g. `mcpe_live_AbCdEf…`)
 *   - `mcpe_4c7b1e9a*`  — the newer key format (e.g. `mcpe_4c7b1e9aAbCd…`)
 *   - Future variants may follow.
 *
 * We accept ANY key whose literal prefix is `mcpe_` and which has at least
 * 20 characters of payload after the prefix (the shortest key MCPEmails
 * issues today is ~32 chars total). The actual key validity is enforced
 * server-side by mcpemails.com when we call `initialize` — so the prefix
 * check here is only a UX guard against obviously-malformed input (paste
 * failures, partial strings, someone pasting a `kv_live_*` Onyx Base key
 * by mistake).
 */
export function isValidMcpeKey(key: string): boolean {
  if (!key) return false
  if (!key.startsWith('mcpe_')) return false
  // At least 20 chars of payload after `mcpe_` (so >= 25 total).
  if (key.length < 25) return false
  // Reject whitespace, control chars, and the obviously-wrong characters.
  return /^[A-Za-z0-9_\-]+$/.test(key)
}

/**
 * Mask an MCPEmails key for safe display. Keeps the prefix + first 4 + last 4
 * characters of the payload, replaces the middle with an ellipsis.
 *
 *   mcpe_live_AbCdEfGhIjKlMnOpQrStUvWxYz123456
 *                  ↓
 *   mcpe_live_AbCd…3456
 *
 *   mcpe_4c7b1e9aAbCdEfGhIjKlMnOpQrStUvWxYz123456
 *                  ↓
 *   mcpe_4c7b1e9aAbCd…3456
 */
export function maskMcpeKey(key: string): string {
  if (!key) return ''
  // Find the prefix boundary (everything up to and including the first `_`
  // after `mcpe`). For `mcpe_live_<payload>` that's `mcpe_live_`. For
  // `mcpe_4c7b1e9a<payload>` (no second `_`) we just slice the first 9 chars.
  const secondUnderscore = key.indexOf('_', 5) // start search after `mcpe_`
  const prefix = secondUnderscore === -1 ? key.slice(0, 9) : key.slice(0, secondUnderscore + 1)
  const payload = key.slice(prefix.length)
  if (payload.length <= 8) return key // too short to mask meaningfully
  return `${prefix}${payload.slice(0, 4)}…${payload.slice(-4)}`
}

/** Get the raw MCPEmail config for a user (server-side only). */
export function getRawMcpeConfig(dbUserId: string): McpeConfigValue | null {
  const rec = findRecord(dbUserId, COLLECTION, KEY)
  if (!rec) return null
  try {
    const parsed = JSON.parse(rec.value) as Partial<McpeConfigValue>
    if (!parsed || typeof parsed.apiKey !== 'string' || !parsed.apiKey) return null
    return {
      apiKey: parsed.apiKey,
      label: parsed.label ?? null,
      fromName: parsed.fromName ?? null,
      subjectTemplate: parsed.subjectTemplate ?? null,
      bodyTemplate: parsed.bodyTemplate ?? null,
      updatedAt: rec.updatedAt,
    }
  } catch {
    return null
  }
}

/** Get a masked view of the MCPEmail config (safe for browser). */
export function getMcpeConfigView(dbUserId: string): McpeConfigPublicView {
  const cfg = getRawMcpeConfig(dbUserId)
  if (!cfg) {
    return {
      hasConfig: false,
      apiKeyMasked: '',
      label: null,
      fromName: null,
      subjectTemplate: null,
      bodyTemplate: null,
      updatedAt: null,
    }
  }
  return {
    hasConfig: true,
    apiKeyMasked: maskMcpeKey(cfg.apiKey),
    label: cfg.label,
    fromName: cfg.fromName,
    subjectTemplate: cfg.subjectTemplate ?? DEFAULT_SUBJECT,
    bodyTemplate: cfg.bodyTemplate ?? DEFAULT_BODY,
    updatedAt: cfg.updatedAt,
  }
}

/** Save (or update) the MCPEmail config for a user. */
export function setMcpeConfig(
  dbUserId: string,
  publicUserId: string,
  opts: {
    apiKey: string
    label?: string | null
    fromName?: string | null
    subjectTemplate?: string | null
    bodyTemplate?: string | null
  },
): McpeConfigValue {
  const trimmedKey = opts.apiKey.trim()
  if (!trimmedKey) throw new Error('MCPEmail API key is required.')
  if (!isValidMcpeKey(trimmedKey)) {
    throw new Error(
      'MCPEmail API key must start with "mcpe_" (e.g. mcpe_live_… or mcpe_4c7b1e9a…) and be at least 25 characters.',
    )
  }
  const value: McpeConfigValue = {
    apiKey: trimmedKey,
    label: opts.label?.trim() || null,
    fromName: opts.fromName?.trim() || null,
    subjectTemplate: opts.subjectTemplate?.trim() || null,
    bodyTemplate: opts.bodyTemplate?.trim() || null,
    updatedAt: new Date().toISOString(),
  }
  upsertRecord(dbUserId, publicUserId, {
    collection: COLLECTION,
    key: KEY,
    value: JSON.stringify(value),
    valueType: 'object',
  })
  return value
}

/** Remove the MCPEmail config for a user. */
export function clearMcpeConfig(dbUserId: string): boolean {
  const removed = deleteRecord(dbUserId, COLLECTION, KEY)
  return removed !== null
}

/** Resolve the effective subject for an OTP send, substituting $CODE. */
export function resolveSubject(cfg: McpeConfigValue, code: string): string {
  const tpl = cfg.subjectTemplate || DEFAULT_SUBJECT
  return tpl.replace(/\$CODE/g, code)
}

/** Resolve the effective body for an OTP send, substituting $CODE. */
export function resolveBody(cfg: McpeConfigValue, code: string): string {
  const tpl = cfg.bodyTemplate || DEFAULT_BODY
  return tpl.replace(/\$CODE/g, code)
}

export const MCPEMAIL_DEFAULT_SUBJECT = DEFAULT_SUBJECT
export const MCPEMAIL_DEFAULT_BODY = DEFAULT_BODY

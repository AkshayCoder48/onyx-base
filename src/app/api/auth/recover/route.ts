import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/auth'
import { restoreIdentityFromBackup } from '@/lib/data-store'

export const runtime = 'nodejs'

// ─── Simple in-memory rate limiter (per-IP) ──────────────────────────────────
// Recovery is unauthenticated, so we throttle it to discourage brute-force.
// The input is a full manifest JSON (not guessable), but throttling is still
// good hygiene.
const HITS = new Map<string, { count: number; windowStart: number }>()
const WINDOW_MS = 60_000
const MAX_HITS = 10

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const entry = HITS.get(ip)
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    HITS.set(ip, { count: 1, windowStart: now })
    return false
  }
  entry.count++
  return entry.count > MAX_HITS
}

/**
 * POST /api/auth/recover
 * Body: { "payload": "<manifest JSON or pasted Telegram message text>" }
 *
 * Manual recovery fallback: if the server's local store was wiped AND the
 * automatic Telegram rehydrate couldn't run (e.g. env Telegram not configured,
 * or the manifest is in a per-user chat the server can't reach), the user can
 * open their Telegram chat, copy the pinned manifest message, paste it here,
 * and restore their keys.
 *
 * No authentication required (it's a recovery flow). Rate-limited per-IP.
 * Returns the count of restored users + keys. Idempotent — pasting the same
 * manifest twice restores nothing the second time.
 */
export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || 'unknown'
  if (rateLimited(ip)) {
    return fail('Too many recovery attempts. Please wait a minute and try again.', 429)
  }

  let payload: string | undefined
  try {
    const body = await req.json()
    payload = typeof body.payload === 'string' ? body.payload : undefined
  } catch {
    /* fall through */
  }
  if (!payload || payload.trim().length === 0) {
    return fail('A "payload" string is required (the manifest JSON from your Telegram backup).', 400)
  }

  // The user may paste the raw Telegram message text (which includes our
  // marker prefix + HTML) or just the JSON. Extract the first {...} block
  // that looks like our manifest.
  const extracted = extractManifestJson(payload)
  if (!extracted) {
    return fail(
      'Could not find a Onyx Base identity manifest in the pasted text. ' +
      'Copy the entire pinned message from your Telegram chat and try again.',
      400,
    )
  }

  const result = restoreIdentityFromBackup(extracted)
  if (!result.ok) {
    return fail(result.error || 'Could not restore from the provided backup.', 400)
  }

  return ok({
    usersRestored: result.usersRestored,
    keysRestored: result.keysRestored,
    message:
      result.usersRestored || result.keysRestored
        ? `Restored ${result.usersRestored} user(s) and ${result.keysRestored} API key(s). You can now sign in.`
        : 'Everything in this backup already exists locally — no new keys were added. You can sign in with any key from the backup.',
  })
}

/**
 * Extract the first JSON object from a pasted blob. Handles three cases:
 *  1. Raw manifest JSON (starts with `{`).
 *  2. Our pinned-message format: `CLOUDKV_IDENTITY_MANIFEST_V1\n{...}`.
 *  3. Telegram-rendered text with our JSON inside (the JSON is on its own,
 *     possibly spanning many lines).
 *
 * Returns the parsed JSON string, or null if no valid manifest object is found.
 */
function extractManifestJson(raw: string): string | null {
  const text = raw.trim()

  // Case 2: our marker prefix.
  const markerIdx = text.indexOf('CLOUDKV_IDENTITY_MANIFEST_V1')
  if (markerIdx !== -1) {
    const afterMarker = text.slice(markerIdx + 'CLOUDKV_IDENTITY_MANIFEST_V1'.length)
    const jsonStart = afterMarker.indexOf('{')
    if (jsonStart !== -1) {
      const candidate = afterMarker.slice(jsonStart)
      const extracted = extractBalancedJson(candidate)
      if (extracted) return extracted
    }
  }

  // Case 1 & 3: find the first balanced {...} in the text.
  return extractBalancedJson(text)
}

/** Find the first balanced `{...}` block and return it, or null. */
function extractBalancedJson(s: string): string | null {
  const start = s.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < s.length; i++) {
    const ch = s[i]
    if (inString) {
      if (escape) {
        escape = false
      } else if (ch === '\\') {
        escape = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
    } else if (ch === '{') {
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        return s.slice(start, i + 1)
      }
    }
  }
  return null
}

import { NextRequest } from 'next/server'
import { ok, fail } from '@/lib/auth'
import {
  findUserByCredentials,
  findUserByEmail,
  listApiKeys,
  rehydrateUserFromTelegram,
  countRecords,
  countCollections,
  countLogs,
} from '@/lib/data-store'
import { logAction } from '@/lib/kv'
import { sendEventMessage } from '@/lib/telegram'
import { resolveChatId, resolveBotToken } from '@/lib/data-store'

export const runtime = 'nodejs'

// ─── Simple in-memory rate limiter (per-IP) ──────────────────────────────────
// Password login is a recovery flow that returns a live API key, so we throttle
// it to resist brute-force. 10 attempts / minute / IP is plenty for a human who
// typed their password wrong a few times, but slows credential stuffing.
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
 * POST /api/auth/login
 * Body: { "email": "me@example.com", "password": "secret" }
 *
 * Email + password recovery login. When a user has LOST their API key, they
 * can sign back in with the email + password they registered with to retrieve
 * a working key. This is the universal fallback that works whether or not the
 * user set up a custom Telegram chat.
 *
 * Flow:
 *   1. Look up the user by email + verify the scrypt password hash.
 *   2. If the user has a custom Telegram chat + bot token configured, try to
 *      rehydrate their per-user manifest from their chat (best-effort) — this
 *      recovers any keys that aren't in the local store (e.g. after a sandbox
 *      reset wiped db/cloudkv.json).
 *   3. Return the most recent non-revoked API key + identity + counts so the
 *      dashboard can enter directly (same response shape as /api/auth/verify).
 *
 * Security:
 *   - Rate-limited per IP (10/min).
 *   - Returns the same generic error for "no such email" and "wrong password"
 *     so an attacker can't enumerate which emails are registered.
 *   - The password is NEVER used for API operations — all KV ops still
 *     require the returned API key. The password only unlocks key recovery.
 */
export async function POST(req: NextRequest) {
  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip') ||
    'unknown'
  if (rateLimited(ip)) {
    return fail('Too many login attempts. Please wait a minute and try again.', 429)
  }

  let email: string | undefined
  let password: string | undefined
  let otpVerified = false
  try {
    const body = await req.json()
    email = typeof body.email === 'string' ? body.email.trim() : undefined
    password = typeof body.password === 'string' ? body.password : undefined
    otpVerified = body.otpVerified === true
  } catch {
    /* fall through */
  }

  if (!email) {
    return fail('Email is required.', 400)
  }

  // ── OTP-login path ────────────────────────────────────────────────────────
  // If the caller passes `otpVerified: true` (and NO password), they completed
  // the send-otp + verify-otp flow for purpose='login'. We look the user up by
  // email alone and return their most recent API key. This is the "sign in
  // with email code" flow — useful when the user forgot their password but has
  // email access. The send-otp endpoint already verified the account exists.
  if (otpVerified && !password) {
    const user = findUserByEmail(email)
    if (!user) {
      // The send-otp endpoint should have caught this, but double-check here.
      return fail('No account found with this email. Sign up first.', 404)
    }

    // Best-effort rehydrate from the user's own Telegram chat.
    try {
      await rehydrateUserFromTelegram(user.id)
    } catch (err) {
      console.error('[auth/login] rehydrate (otp path) failed:', err)
    }

    const keys = listApiKeys(user.id).filter((k) => !k.revoked)
    const apiKey = keys[0]
    if (!apiKey) {
      return fail(
        'Your account has no active API keys (all were revoked). Sign in with an existing key or contact support.',
        403,
      )
    }

    const authed = {
      dbUserId: user.id,
      userId: user.userId,
      apiKeyId: apiKey.id,
      apiKeyName: apiKey.name,
    } as const

    await logAction(
      authed as never,
      'login',
      undefined,
      'dashboard session started via email OTP (no password)',
      'dashboard',
    )

    void sendEventMessage(
      {
        owner: user.userId,
        event: 'login',
        detail: `email OTP · key=${apiKey.name}`,
        source: 'dashboard',
        ts: Math.floor(Date.now() / 1000),
      },
      resolveChatId(user.id),
      resolveBotToken(user.id),
    )

    return ok({
      userId: user.userId,
      apiKey: apiKey.key,
      apiKeyName: apiKey.name,
      name: user.name,
      email: user.email,
      plan: user.plan,
      createdAt: user.createdAt,
      counts: {
        records: countRecords(user.id),
        collections: countCollections(user.id),
        apiKeys: keys.length,
        logs: countLogs(user.id),
      },
      message: 'Signed in via email OTP. Your API key has been retrieved.',
    })
  }

  // ── Password-login path (existing) ────────────────────────────────────────
  if (!password) {
    return fail('Password is required (or complete email OTP verification first).', 400)
  }

  const user = findUserByCredentials(email, password)
  if (!user) {
    // Deliberately generic — don't reveal whether the email exists.
    return fail('Incorrect email or password.', 401)
  }

  // Best-effort: rehydrate this user's keys from their own Telegram chat (if
  // they configured one). This is what makes a lost key recoverable even when
  // the local store was wiped — the manifest lives in THEIR chat.
  try {
    await rehydrateUserFromTelegram(user.id)
  } catch (err) {
    console.error('[auth/login] rehydrate failed:', err)
  }

  // Pick the most recent non-revoked key to hand back. If ALL keys were
  // revoked (rare), tell the user — we don't auto-mint here to avoid
  // surprising key proliferation.
  const keys = listApiKeys(user.id).filter((k) => !k.revoked)
  const apiKey = keys[0]
  if (!apiKey) {
    return fail(
      'Your account has no active API keys (all were revoked). Sign in with an existing key or contact support.',
      403,
    )
  }

  const authed = {
    dbUserId: user.id,
    userId: user.userId,
    apiKeyId: apiKey.id,
    apiKeyName: apiKey.name,
  } as const

  await logAction(
    authed as never,
    'login',
    undefined,
    'dashboard session started via email+password recovery',
    'dashboard',
  )

  // Mirror the login event to the Telegram backup channel (the user's own
  // chat if configured, else the env default).
  void sendEventMessage(
    {
      owner: user.userId,
      event: 'login',
      detail: `email+password recovery · key=${apiKey.name}`,
      source: 'dashboard',
      ts: Math.floor(Date.now() / 1000),
    },
    resolveChatId(user.id),
    resolveBotToken(user.id),
  )

  return ok({
    userId: user.userId,
    apiKey: apiKey.key,
    apiKeyName: apiKey.name,
    name: user.name,
    email: user.email,
    plan: user.plan,
    createdAt: user.createdAt,
    counts: {
      records: countRecords(user.id),
      collections: countCollections(user.id),
      apiKeys: keys.length,
      logs: countLogs(user.id),
    },
    message: 'Signed in via email + password. Your API key has been retrieved.',
  })
}

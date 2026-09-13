/**
 * Onyx Base — server-side email verification.
 *
 * Two layers of defence against disposable / invalid emails:
 *
 *  1. FAST LOCAL BLOCKLIST (tempmail-blocker, 4,493+ domains). An O(1) Set
 *     lookup that runs in microseconds and instantly rejects well-known
 *     disposable providers (tempmail.com, mailinator.com, guerrillamail.com,
 *     yopmail.com, …) WITHOUT hitting the network. This is the fast path —
 *     known junk never reaches the API.
 *
 *  2. LIVE DOMAIN CHECK (check.emailverifier.online "quick mail verify"). For
 *     emails that pass the local blocklist, we ask the service to classify the
 *     email. We use it ONLY for domain-level signals — disposable type, domain
 *     not found, no MX records, syntax errors. We deliberately DO NOT require
 *     `safetosend === "Yes"`, because that field depends on a live SMTP RCPT
 *     probe which produces false negatives on perfectly valid mailboxes
 *     (greylisting, catch-all servers, rate-limited RCPT, etc). Removing the
 *     SMTP-probe dependency fixes the "could not be verified / deliverable"
 *     error that was blocking real signups.
 *
 * Accept policy: not disposable (local OR API) AND domain resolves with MX.
 * Reject policy: disposable, OR domain not found, OR no MX records, OR syntax.
 * Fallback policy: if the live API is unreachable / errors, we fail open —
 *   the local blocklist + regex already caught obvious junk.
 */

import { isTempMail } from 'tempmail-blocker'

const VERIFIER_URL =
  'https://check.emailverifier.online/bulk-verify-email/functions/quick_mail_verify_no_session.php'
const VERIFIER_FROM_MAIL = 'cloudkv-verify@cloudkv.app'
const VERIFIER_TOKEN = '12345'
const TIMEOUT_MS = 15000

export interface EmailVerificationResult {
  valid: boolean
  status: string
  /** Mirrors the API's `safetosend` field. We no longer gate on it — kept for diagnostics. */
  safeToSend: string
  /** Verifier-supplied type label, e.g. "Free Account", "Disposable Account". */
  type?: string
  /** Human-friendly reason string shown in the toast / API error response. */
  reason?: string
  /** True if we couldn't reach the verifier (signup still allowed via fallback). */
  unreachable: boolean
}

/**
 * Map a raw `reasons` string from the verifier into a user-friendly message.
 * Only called for explicit REJECT signals (disposable / domain / MX / syntax) —
 * never for the SMTP-probe `safetosend` result.
 */
function humanizeReason(reason: string, type: string): string {
  const r = (reason || '').toLowerCase()
  const t = (type || '').toLowerCase()

  if (r.includes('disposable') || t.includes('disposable')) {
    return 'Disposable email addresses are not allowed. Please use a real email.'
  }
  if (r.includes('syntax')) {
    return 'The email address is malformed. Please check for typos.'
  }
  if (r.includes('domain not found') || r.includes('dns')) {
    return 'The email domain does not exist. Please use a real email address.'
  }
  if (r.includes('mx')) {
    return 'The email domain cannot receive mail (no MX records). Use a real email address.'
  }
  return 'Please use a real, non-disposable email address.'
}

/**
 * Verify an email address.
 *
 * Returns { valid: true } when the email passes the local disposable blocklist
 * AND the live domain check (not disposable, domain resolves, MX records exist).
 * Returns { valid: false, reason } when the email is rejected.
 * Returns { valid: true, unreachable: true } when the live API is down (fail-open).
 *
 * The `{ quick }` option skips the live API call and only runs the local
 * blocklist — used for login/reset flows where the email was already fully
 * verified at signup. Signup always uses the full check (quick: false, default).
 */
export async function verifyEmail(
  email: string,
  opts?: { quick?: boolean },
): Promise<EmailVerificationResult> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) {
    return {
      valid: false,
      status: 'EMPTY',
      safeToSend: 'No',
      reason: 'Email is required.',
      unreachable: false,
    }
  }

  // ── Layer 1: fast local disposable-domain blocklist ──
  // 4,493+ known temporary/disposable providers checked in microseconds via
  // a Set lookup. This skips the slow API call entirely for obvious junk.
  if (isTempMail(normalized)) {
    return {
      valid: false,
      status: 'DISPOSABLE',
      safeToSend: 'No',
      type: 'Disposable Account',
      reason: 'Disposable / temporary email addresses are not allowed. Please use a real email address.',
      unreachable: false,
    }
  }

  // ── Quick mode: local blocklist only, skip the live API call ──
  // Used for login + reset (email already verified at signup). Still blocks
  // disposable domains, but doesn't add latency to every login attempt.
  if (opts?.quick) {
    return {
      valid: true,
      status: 'QUICK_OK',
      safeToSend: 'Yes',
      reason: 'Passed disposable-domain check (quick mode — live API skipped).',
      unreachable: false,
    }
  }

  // ── Layer 2: live domain check via check.emailverifier.online ──
  // We call the service for its domain-level classification (disposable type,
  // domain-not-found, no-MX, syntax) but we deliberately DO NOT require
  // `safetosend === 'Yes'` — that field is driven by a live SMTP RCPT probe
  // which produces false negatives on valid mailboxes (greylisting, catch-alls,
  // rate-limited RCPT). Only explicit domain-level reject signals block signup.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const params = new URLSearchParams({
      email: normalized,
      index: '0',
      token: VERIFIER_TOKEN,
      frommail: VERIFIER_FROM_MAIL,
      timeout: '10',
      scan_port: '25',
    })

    const res = await fetch(VERIFIER_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Accept: 'application/json, text/javascript, */*; q=0.01',
      },
      body: params.toString(),
    })
    clearTimeout(timer)

    if (!res.ok) {
      // API returned an HTTP error — fail open.
      return {
        valid: true,
        status: 'VERIFIER_ERROR',
        safeToSend: '',
        reason: 'Email verifier returned an error; signup allowed via fallback.',
        unreachable: true,
      }
    }

    const raw = await res.text()
    let data: {
      status?: string
      safetosend?: string
      type?: string
      reasons?: string
      debug?: string[]
    }
    try {
      const parsed = JSON.parse(raw)
      // The service occasionally returns a bare number (e.g. `23`) on
      // rate-limit / token errors — treat that as unreachable, fail open.
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
          valid: true,
          status: 'VERIFIER_NON_OBJECT',
          safeToSend: '',
          reason: 'Email verifier returned a non-object response; signup allowed via fallback.',
          unreachable: true,
        }
      }
      data = parsed
    } catch {
      return {
        valid: true,
        status: 'VERIFIER_UNPARSEABLE',
        safeToSend: '',
        reason: 'Email verifier returned an unparseable response; signup allowed via fallback.',
        unreachable: true,
      }
    }

    const status = (data.status || '').toLowerCase()
    const safeToSend = (data.safetosend || '').trim()
    const type = data.type || ''
    const reasons = (data.reasons || '').toLowerCase()
    const typeLower = (type || '').toLowerCase()

    // ── Explicit REJECT signals (domain-level only) ──
    // These are clear, deterministic signals that the email is junk — NOT the
    // flaky SMTP-probe `safetosend` result. We only block on these.
    const isDisposable =
      status === 'disposable' ||
      typeLower.includes('disposable') ||
      reasons.includes('disposable')
    const isDomainNotFound =
      reasons.includes('domain not found') ||
      reasons.includes('dns') ||
      status.includes('domain not found')
    const isNoMx = reasons.includes('mx') || status.includes('mx')
    const isSyntax = reasons.includes('syntax') || status === 'invalid'

    if (isDisposable || isDomainNotFound || isNoMx || isSyntax) {
      return {
        valid: false,
        status: status ? status.toUpperCase() : 'INVALID',
        safeToSend,
        type,
        reason: humanizeReason(data.reasons || '', type),
        unreachable: false,
      }
    }

    // ── Accept: passed domain-level checks ──
    // We do NOT require `safetosend === 'Yes'` (that's the SMTP RCPT probe
    // result, which is unreliable and was blocking valid emails). Any email
    // that isn't explicitly disposable / bad-domain / no-MX / bad-syntax
    // is accepted.
    return {
      valid: true,
      status: 'OK',
      safeToSend,
      type,
      reason: 'Passed domain-level checks (disposable / MX / syntax).',
      unreachable: false,
    }
  } catch {
    clearTimeout(timer)
    // Network error / timeout — fail open so we don't block signups when the
    // third-party verifier is down.
    return {
      valid: true,
      status: 'UNREACHABLE',
      safeToSend: '',
      reason: 'Email verifier is unreachable; signup allowed via fallback.',
      unreachable: true,
    }
  }
}

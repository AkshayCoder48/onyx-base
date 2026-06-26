/**
 * Onyx Base — server-side email verification.
 *
 * Two layers of defence against disposable / invalid emails:
 *
 *  1. FAST LOCAL BLOCKLIST (tempmail-blocker, 4,493+ domains). An O(1) Set
 *     lookup that runs in microseconds and instantly rejects well-known
 *     disposable providers (tempmail.com, mailinator.com, guerrillamail.com,
 *     yopmail.com, …) WITHOUT hitting the network. This is the "skip to
 *     content" fast path — known junk never reaches the slow API.
 *
 *  2. LIVE SMTP PROBE (check.emailverifier.online "quick mail verify"). For
 *     emails that pass the local blocklist, we do a real deliverability check
 *     — DNS/MX lookup + an actual SMTP RCPT conversation. This catches
 *     non-existent mailboxes and disposable domains NOT in the local list.
 *
 * Accept policy: not in the local disposable list AND (status === "valid" AND
 * safetosend === "Yes") from the live probe.
 * Reject policy: in the local list, OR anything the probe marks invalid.
 *
 * Fallback policy: if the live probe is unreachable / errors, we do NOT block
 * the signup (fail-open) — the local blocklist + regex already caught obvious
 * junk. Blocking on a third-party outage would lock everyone out.
 */

import { isTempMail } from 'tempmail-blocker'

const VERIFIER_URL =
  'https://check.emailverifier.online/bulk-verify-email/functions/quick_mail_verify_no_session.php'
const VERIFIER_FROM_MAIL = 'cloudkv-verify@cloudkv.app'
const VERIFIER_TOKEN = '12345'
const TIMEOUT_MS = 20000 // the verifier does a live SMTP probe, give it room

export interface EmailVerificationResult {
  valid: boolean
  status: string
  /** "Yes" | "No" | "" — mirrors the API's `safetosend` field. */
  safeToSend: string
  /** Verifier-supplied type label, e.g. "Free Account", "Disposable Account". */
  type?: string
  /** Verifier-supplied reason string, e.g. "success", "domain not found". */
  reason?: string
  /** True if we couldn't reach the verifier (signup still allowed via fallback). */
  unreachable: boolean
}

/**
 * Map a raw `reasons` string from the verifier into a user-friendly message
 * shown in the toast / API error response.
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
  if (r.includes('mailbox') || r.includes('recipient') || r.includes('not found')) {
    return 'This email address does not exist. Please check for typos or use a real email.'
  }
  if (r.includes('timeout')) {
    return 'The email server took too long to respond. Please try again.'
  }
  return 'This email address could not be verified. Please use a valid, deliverable email.'
}

/**
 * Verify an email address against the check.emailverifier.online service.
 *
 * Returns { valid: true } when the email is confirmed deliverable.
 * Returns { valid: false, reason } when the email is rejected.
 * Returns { valid: true, unreachable: true } when the API is down (fail-open).
 */
export async function verifyEmail(email: string): Promise<EmailVerificationResult> {
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
  // a Set lookup. This skips the slow SMTP probe entirely for obvious junk.
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

  // ── Layer 2: live SMTP deliverability probe ──
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    // The verifier expects form-encoded POST body (NOT JSON).
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
      // Verifier returned an HTTP error — fail open.
      return {
        valid: true,
        status: 'VERIFIER_ERROR',
        safeToSend: '',
        reason: 'Email verifier returned an error; signup allowed via fallback.',
        unreachable: true,
      }
    }

    const data = (await res.json()) as {
      status?: string
      safetosend?: string
      type?: string
      reasons?: string
      debug?: string[]
    }

    const status = (data.status || '').toLowerCase()
    const safeToSend = (data.safetosend || '').trim()
    const type = data.type || ''
    const reasons = data.reasons || ''

    // ── Accept: explicitly valid AND safe to send ──
    if (status === 'valid' && safeToSend.toLowerCase() === 'yes') {
      return {
        valid: true,
        status: 'VALID',
        safeToSend,
        type,
        reason: reasons,
        unreachable: false,
      }
    }

    // ── Reject: everything else ──
    return {
      valid: false,
      status: status ? status.toUpperCase() : 'INVALID',
      safeToSend,
      type,
      reason: humanizeReason(reasons, type),
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

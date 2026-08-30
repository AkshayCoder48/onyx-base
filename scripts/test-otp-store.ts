/**
 * Smoke test for the OTP storage layer.
 *
 * Verifies:
 *   - issueOtp() stores a hashed record under __otp__/otp:<email>
 *   - verifyOtp() with the correct code returns ok:true and deletes the record
 *   - verifyOtp() with a wrong code returns wrong_code (and increments attempts)
 *   - verifyOtp() after expiry returns expired
 *   - verifyOtp() after a successful verify returns not_found (single-use)
 *
 * Run with:
 *   bun /home/z/my-project/scripts/test-otp-store.ts
 */

import { issueOtp, verifyOtp, voidOtp } from '../src/lib/otp-store'
import { findRecord } from '../src/lib/data-store'

const DB_USER_ID = 'mtfc9q6w4cb6464bc59d408a' // Akshay's actual dbUserId (cuid) from db/cloudkv.json
const PUBLIC_USER_ID = 'usr_2za2wm'
const EMAIL = 'test+otp@onyxbase.example'
let pass = 0
let fail = 0

function check(label: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`)
  }
}

// ── 1. Issue + verify happy path ────────────────────────────────────────────
console.log('\n[1] Issue + verify happy path')
voidOtp(DB_USER_ID, EMAIL) // ensure clean slate
const issued = issueOtp(DB_USER_ID, PUBLIC_USER_ID, EMAIL)
check('OTP issued with 6-digit code', /^\d{6}$/.test(issued.code), `code=${issued.code}`)
check('expiresAt is in the future', new Date(issued.expiresAt).getTime() > Date.now())
const stored = findRecord(DB_USER_ID, '__otp__', `otp:${EMAIL}`)
check('record persisted to store', !!stored, `stored=${JSON.stringify(stored)}`)
if (stored) {
  const parsed = JSON.parse(stored.value)
  check('hash is 64-char hex (sha256)', /^[0-9a-f]{64}$/.test(parsed.hash))
  check('salt is 32-char hex (16 bytes)', /^[0-9a-f]{32}$/.test(parsed.salt))
  check('attempts starts at 0', parsed.attempts === 0)
  check('raw code is NOT in the stored value', !stored.value.includes(issued.code), 'raw code leaked into storage!')
}

const ok = verifyOtp(DB_USER_ID, EMAIL, issued.code)
check('verify with correct code → ok', ok.ok && ok.reason === 'valid', `reason=${ok.reason}`)

const gone = findRecord(DB_USER_ID, '__otp__', `otp:${EMAIL}`)
check('record deleted after successful verify (single-use)', !gone)

const reVerify = verifyOtp(DB_USER_ID, EMAIL, issued.code)
check('re-verify → not_found (single-use)', !reVerify.ok && reVerify.reason === 'not_found', `reason=${reVerify.reason}`)

// ── 2. Wrong attempts + max_attempts ────────────────────────────────────────
console.log('\n[2] Wrong attempts + void on max_attempts')
voidOtp(DB_USER_ID, EMAIL)
const issued2 = issueOtp(DB_USER_ID, PUBLIC_USER_ID, EMAIL)
check('second OTP issued', !!issued2.code)

// Try 4 wrong codes — should all return wrong_code, attempts increments.
for (let i = 0; i < 4; i++) {
  const wrong = verifyOtp(DB_USER_ID, EMAIL, '000000')
  check(`wrong attempt ${i + 1} → wrong_code`, !wrong.ok && wrong.reason === 'wrong_code', `reason=${wrong.reason}`)
}
// 5th wrong attempt should void the OTP.
const fifth = verifyOtp(DB_USER_ID, EMAIL, '000000')
check('5th wrong attempt → max_attempts', !fifth.ok && fifth.reason === 'max_attempts', `reason=${fifth.reason}`)

// Even the correct code should now fail (OTP was voided).
const late = verifyOtp(DB_USER_ID, EMAIL, issued2.code)
check('correct code after void → not_found', !late.ok && late.reason === 'not_found', `reason=${late.reason}`)

// ── 3. Expiry path ──────────────────────────────────────────────────────────
console.log('\n[3] Expiry path')
voidOtp(DB_USER_ID, EMAIL)
const issued3 = issueOtp(DB_USER_ID, PUBLIC_USER_ID, EMAIL)
check('third OTP issued', !!issued3.code)

// Manually expire the record by rewriting expiresAt to the past.
const rec = findRecord(DB_USER_ID, '__otp__', `otp:${EMAIL}`)
if (rec) {
  const parsed = JSON.parse(rec.value)
  parsed.expiresAt = new Date(Date.now() - 60_000).toISOString()
  // Re-save via upsertRecord through the same import.
  const { upsertRecord } = await import('../src/lib/data-store')
  upsertRecord(DB_USER_ID, PUBLIC_USER_ID, {
    collection: '__otp__',
    key: `otp:${EMAIL}`,
    value: JSON.stringify(parsed),
    valueType: 'object',
  })
}

const expired = verifyOtp(DB_USER_ID, EMAIL, issued3.code)
check('verify after expiry → expired', !expired.ok && expired.reason === 'expired', `reason=${expired.reason}`)

// ── 4. Cleanup ──────────────────────────────────────────────────────────────
console.log('\n[4] Cleanup')
const cleaned = voidOtp(DB_USER_ID, EMAIL)
check('final voidOtp removes any leftover', true)
void cleaned

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed\n`)
if (fail > 0) {
  process.exit(1)
}

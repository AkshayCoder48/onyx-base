#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- CJS test script */
/** Email Automation API test suite (PRD §30–§31).
 *
 * Usage:
 *   ONYX_KEY=kv_live_… node scripts/test-email-automation.js
 *   ONYX_KEY=… BASE_URL=https://onyxbase-phi.vercel.app node scripts/test-email-automation.js
 *   ONYX_ADMIN_KEY=onyxbase_…  (optional — enables the cross-user isolation test)
 *
 * Uses a SYNTHETIC mcpe_ key (valid format, not a real credential), so the
 * upstream MCPEmail call fails authentication — the suite asserts the
 * sanitized error mapping, never a real email send. Every artifact the suite
 * creates (credentials, template) is deleted in the cleanup phase.
 */

const crypto = require('crypto')

const BASE = process.env.BASE_URL || 'http://localhost:3000'
const KEY = process.env.ONYX_KEY || ''
const ADMIN_KEY = process.env.ONYX_ADMIN_KEY || ''

if (!KEY) {
  console.error('ONYX_KEY is required (no hardcoded defaults — secret hygiene).')
  process.exit(1)
}

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }
const SUFFIX = crypto.randomBytes(4).toString('hex')
const CRED = `test_ea_${SUFFIX}`
const CRED_RL = `test_rl_${SUFFIX}`
const TPL = `test_tpl_${SUFFIX}`
const RAW_KEY = 'mcpe_' + crypto.randomBytes(32).toString('hex') // valid FORMAT, fake credential
const RECIPIENT = 'email-automation-test@example.invalid'

let pass = 0
let fail = 0
const failures = []

async function call(method, path, body, headers) {
  const res = await fetch(BASE + path, {
    method,
    headers: headers ?? H,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* non-JSON */ }
  return { status: res.status, json, text }
}

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; failures.push(name); console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`) }
}

async function main() {
  console.log(`Email Automation test suite → ${BASE}`)
  console.log(`  synthetic credential names: ${CRED}, ${CRED_RL}; template: ${TPL}\n`)

  // ── 1. Public docs (anonymous) ──────────────────────────────────────────
  console.log('〔1〕Public documentation (anonymous)')
  {
    const docs = await call('GET', '/docs', undefined, {})
    check('GET /docs anonymous → 200', docs.status === 200)
    check('/docs mentions Email Automation', /Email Automation/.test(docs.text), docs.text.slice(0, 80))

    const spec = await call('GET', '/api/openapi.json', undefined, {})
    check('GET /api/openapi.json anonymous → 200', spec.status === 200)
    check('spec has /api/email/send path', spec.json && spec.json.paths && '/api/email/send' in spec.json.paths)
    check('spec has /api/credentials/connect path', spec.json && spec.json.paths && '/api/credentials/connect' in spec.json.paths)
    check('spec marks /api/email-otp/send deprecated', spec.json && spec.json.paths['/api/email-otp/send']?.post?.deprecated === true)

    const llms = await call('GET', '/llms.txt', undefined, {})
    check('/llms.txt mentions Email Automation', /Email Automation/.test(llms.text))
  }

  // ── 2. Authentication ───────────────────────────────────────────────────
  console.log('〔2〕Platform API key authentication')
  {
    const noKey = await call('POST', '/api/email/send', { credential: CRED, to: RECIPIENT, subject: 'x', body: 'x' }, { 'Content-Type': 'application/json' })
    check('no key → 401 invalid_api_key', noKey.status === 401 && noKey.json?.code === 'invalid_api_key')

    const badKey = await call('POST', '/api/email/send', { credential: CRED, to: RECIPIENT, subject: 'x', body: 'x' }, { Authorization: 'Bearer kv_live_totally_invalid_key', 'Content-Type': 'application/json' })
    check('invalid platform key → 401', badKey.status === 401)
  }

  // ── 3. Old OTP endpoints → 410 migration ────────────────────────────────
  console.log('〔3〕OTP deprecation (fail closed, never routed)')
  {
    const send = await call('POST', '/api/email-otp/send', { email: 'x@example.com' })
    check('POST /api/email-otp/send → 410', send.status === 410)
    check('send migration points to /api/email/send', send.json?.migration?.newEndpoint === '/api/email/send')
    check('send says deprecated', send.json?.deprecated === true)

    const verify = await call('POST', '/api/email-otp/verify', { email: 'x@example.com', code: '123456' })
    check('POST /api/email-otp/verify → 410', verify.status === 410)

    const legacy = await call('PUT', '/api/dashboard/mcpemail-config', { apiKey: 'mcpe_4c7b1e9a0d5f38a2b6e04d17c9f2a58b3d6e0f1a2b4c6d8e0f2a4b6c8d0e1f3a' })
    check('legacy dashboard PUT → 410', legacy.status === 410 && legacy.json?.deprecated === true)
  }

  // ── 4. Credential connect ───────────────────────────────────────────────
  console.log('〔4〕Credential management (named, masked, fail-closed)')
  {
    const badName = await call('POST', '/api/credentials/connect', { name: '-bad-name!', apiKey: RAW_KEY, testConnection: false })
    check('bad name → 400 bad_name', badName.status === 400 && badName.json?.code === 'bad_name')

    const badKey = await call('POST', '/api/credentials/connect', { name: CRED, apiKey: 'not_mcpe_at_all', testConnection: false })
    check('bad key format → 400 bad_key', badKey.status === 400 && badKey.json?.code === 'bad_key')

    const saved = await call('POST', '/api/credentials/connect', { name: CRED, apiKey: RAW_KEY, label: 'EA suite', rateLimitPerMin: null, testConnection: false })
    check('connect synthetic credential → 200', saved.status === 200)
    check('response is a masked view', saved.json?.credential?.apiKeyMasked?.startsWith('mcpe_') && !saved.json?.credential?.apiKeyMasked?.includes(RAW_KEY.slice(5, 40)))
    check('raw key NOT in connect response', !JSON.stringify(saved.json ?? {}).includes(RAW_KEY))
    check('request_id present', typeof saved.json?.request_id === 'string' && saved.json.request_id.startsWith('req_'))

    const savedRl = await call('POST', '/api/credentials/connect', { name: CRED_RL, apiKey: RAW_KEY, rateLimitPerMin: 2, testConnection: false })
    check('connect rate-limited credential (2/min) → 200', savedRl.status === 200 && savedRl.json?.credential?.rateLimitPerMin === 2)

    const list = await call('GET', '/api/credentials')
    check('list → 200 and includes new credential', list.status === 200 && Array.isArray(list.json?.credentials) && list.json.credentials.some((c) => c.name === CRED))
    check('raw key NOT in list response', !JSON.stringify(list.json ?? {}).includes(RAW_KEY))

    const one = await call('GET', `/api/credentials/${CRED}`)
    check('GET /api/credentials/:name → 200 masked', one.status === 200 && one.json?.credential?.name === CRED)

    const missing = await call('GET', '/api/credentials/definitely_not_a_real_credential_x9')
    check('unknown credential name → 404 credential_not_found', missing.status === 404 && missing.json?.code === 'credential_not_found')
  }

  // ── 5. Send validation + variable engine ────────────────────────────────
  console.log('〔5〕Send pipeline: validation, $VAR_NAME$, fail-closed')
  {
    const noCred = await call('POST', '/api/email/send', { credential: 'ghost_credential', to: RECIPIENT, subject: 's', body: 'b' })
    check('unknown credential → 404 credential_not_found (no fallback)', noCred.status === 404 && noCred.json?.code === 'credential_not_found')

    const badEmail = await call('POST', '/api/email/send', { credential: CRED, to: 'not-an-email', subject: 's', body: 'b' })
    check('bad recipient → 400 bad_recipient', badEmail.status === 400 && badEmail.json?.code === 'bad_recipient')

    const noSubject = await call('POST', '/api/email/send', { credential: CRED, to: RECIPIENT, body: 'b' })
    check('missing subject → 400', noSubject.status === 400)

    const missingVar = await call('POST', '/api/email/send', { credential: CRED, to: RECIPIENT, subject: 'Hi $NAME$', body: 'Code: $OTP$', variables: { NAME: 'Akshay' } })
    check('missing variable → 400 missing_variable', missingVar.status === 400 && missingVar.json?.code === 'missing_variable')
    check('missing variable NAME identifies $OTP$', missingVar.json?.variable === 'OTP')
    check('missing variable names the field', typeof missingVar.json?.field === 'string')
    check('missing variable carries request_id', typeof missingVar.json?.request_id === 'string')

    const subjectVar = await call('POST', '/api/email/send', { credential: CRED, to: RECIPIENT, subject: 'Hi', body: 'plain', variables: {} })
    // Subject without variables + synthetic (fake) key → upstream auth failure, sanitized.
    check('send with fake key → 502/504 upstream_* (sanitized)', [502, 504].includes(subjectVar.status), `got ${subjectVar.status} ${JSON.stringify(subjectVar.json).slice(0, 120)}`)
    check('upstream failure maps to upstream_* code', ['upstream_authentication_failed', 'upstream_error', 'upstream_timeout', 'upstream_rate_limited'].includes(subjectVar.json?.code))
    check('raw mcpe key NOT in upstream error response', !JSON.stringify(subjectVar.json ?? {}).includes(RAW_KEY))
    check('upstream failure carries request_id', typeof subjectVar.json?.request_id === 'string')

    // Store one request id from the flow for the status test.
    globalThis.__requestId = subjectVar.json?.request_id
  }

  // ── 6. Templates ────────────────────────────────────────────────────────
  console.log('〔6〕Templates (structure saved once, variables per request)')
  {
    const save = await call('POST', '/api/email/templates', { name: TPL, subject: 'Welcome $NAME$', body: 'Hello $NAME$, your code is $OTP$.' })
    check('save template → 200', save.status === 200)
    check('template lists detected variables', Array.isArray(save.json?.template?.variables) && save.json.template.variables.includes('OTP'))

    const list = await call('GET', '/api/email/templates')
    check('template appears in list', list.status === 200 && list.json?.templates?.some((t) => t.name === TPL))

    const unknown = await call('POST', '/api/email/template/send', { credential: CRED, template: 'no_such_template', to: RECIPIENT, variables: {} })
    check('unknown template → 404 template_not_found', unknown.status === 404 && unknown.json?.code === 'template_not_found')

    const missingVar = await call('POST', '/api/email/template/send', { credential: CRED, template: TPL, to: RECIPIENT, variables: { NAME: 'Akshay' } })
    check('template send missing variable → 400 missing_variable ($OTP$)', missingVar.status === 400 && missingVar.json?.code === 'missing_variable' && missingVar.json?.variable === 'OTP')

    const inline = await call('POST', '/api/email/template/send', { credential: CRED, template: { subject: 'Hi $X$', body: 'v=$X$' }, to: RECIPIENT, variables: { X: '1' } })
    check('inline template + vars → upstream_* (fake key)', [502, 504].includes(inline.status) && String(inline.json?.code).startsWith('upstream'))
  }

  // ── 7. Request status tracking ──────────────────────────────────────────
  console.log('〔7〕Request IDs + status (metadata only)')
  {
    const reqId = globalThis.__requestId
    check('a request_id was captured from the send flow', typeof reqId === 'string')
    if (typeof reqId === 'string') {
      const st = await call('GET', `/api/email/status/${reqId}`)
      check('GET /api/email/status/:id → 200', st.status === 200)
      check('status is metadata-only shape', st.status === 200 && typeof st.json?.credential === 'string' && typeof st.json?.latency_ms === 'number' && !('body' in (st.json ?? {})))
      check('status never leaks the raw key', !JSON.stringify(st.json ?? {}).includes(RAW_KEY))
    }
    const unknown = await call('GET', '/api/email/status/req_0000000000aaaaaaaabbbb')
    check('unknown request id → 404 request_not_found', unknown.status === 404 && unknown.json?.code === 'request_not_found')

    const recent = await call('GET', '/api/email/requests')
    check('GET /api/email/requests → 200 array', recent.status === 200 && Array.isArray(recent.json?.requests))
    check('recent list contains our credential', (recent.json?.requests ?? []).some((r) => r.credential === CRED))
    check('recent list never contains raw key or body', !JSON.stringify(recent.json ?? {}).includes(RAW_KEY))
  }

  // ── 8. Custom per-credential rate limit (2/min) ─────────────────────────
  console.log('〔8〕Custom MCPEmail rate limit (credential rateLimitPerMin)')
  {
    // Sends 1 and 2 pass the limiter (fail upstream on the fake key); send 3
    // must trip the limiter BEFORE any upstream call.
    const r1 = await call('POST', '/api/email/send', { credential: CRED_RL, to: RECIPIENT, subject: 'a', body: 'b' })
    const r2 = await call('POST', '/api/email/send', { credential: CRED_RL, to: RECIPIENT, subject: 'a', body: 'b' })
    check('rate-limited credential sends 1–2 → 502/504 (upstream, allowed)', [502, 504].includes(r1.status) && [502, 504].includes(r2.status), `r1=${r1.status} r2=${r2.status}`)
    const r3 = await call('POST', '/api/email/send', { credential: CRED_RL, to: RECIPIENT, subject: 'a', body: 'b' })
    check('send 3 → 429 rate_limited (custom limit enforced)', r3.status === 429 && r3.json?.code === 'rate_limited')
    check('429 includes retryAfter', typeof r3.json?.retryAfter === 'number')
    // A different credential is NOT affected by CRED_RL's limit.
    const other = await call('POST', '/api/email/send', { credential: CRED, to: RECIPIENT, subject: 'a', body: 'b' })
    check('other credential unaffected → 502/504 (not 429)', [502, 504].includes(other.status), `got ${other.status}`)
  }

  // ── 9. Cross-user isolation (admin virtual user ≠ the test user) ────────
  console.log('〔9〕Cross-user credential isolation')
  if (ADMIN_KEY) {
    const AH = { Authorization: `Bearer ${ADMIN_KEY}`, 'Content-Type': 'application/json' }
    const list = await call('GET', '/api/credentials', undefined, AH)
    check('admin (different tenant) sees NO test credential', list.status === 200 && !(list.json?.credentials ?? []).some((c) => c.name === CRED || c.name === CRED_RL))
    const probe = await call('GET', `/api/credentials/${CRED}`, undefined, AH)
    check("admin cannot read the user's credential → 404", probe.status === 404)
    const st = await call('GET', `/api/email/status/${globalThis.__requestId ?? 'req_none'}`, undefined, AH)
    check("admin cannot read the user's request status → 404", st.status === 404, `got ${st.status}`)
  } else {
    console.log('  (skipped — set ONYX_ADMIN_KEY to run the cross-user isolation checks)')
  }

  // ── 10. Server-log redaction (local dev only) ───────────────────────────
  if (BASE.includes('localhost') || BASE.includes('127.0.0.1')) {
    console.log('〔10〕Log redaction (local dev.log)')
    const fs = require('fs')
    const path = require('path')
    try {
      const log = path.join(__dirname, '..', 'dev.log')
      const stat = fs.statSync(log)
      const start = Math.max(0, stat.size - 64 * 1024)
      const fd = fs.openSync(log, 'r')
      const buf = Buffer.alloc(stat.size - start)
      fs.readSync(fd, buf, 0, buf.length, start)
      fs.closeSync(fd)
      const tail = buf.toString('utf8')
      check('raw synthetic mcpe key NEVER appears in recent server logs', !tail.includes(RAW_KEY))
    } catch (e) {
      console.log(`  (dev.log not readable: ${e.message})`)
    }
  }

  // ── 11. Cleanup ─────────────────────────────────────────────────────────
  console.log('〔11〕Cleanup')
  {
    const d1 = await call('DELETE', `/api/credentials/${CRED}`)
    const d2 = await call('DELETE', `/api/credentials/${CRED_RL}`)
    const d3 = await call('DELETE', `/api/email/templates/${TPL}`)
    check('test credential deleted', d1.status === 200)
    check('rate-limit credential deleted', d2.status === 200)
    check('test template deleted', d3.status === 200)

    const list = await call('GET', '/api/credentials')
    const gone = (list.json?.credentials ?? []).every((c) => c.name !== CRED && c.name !== CRED_RL)
    check('credentials list is clean', gone)
  }

  console.log(`\n──────────────────────────────────────`)
  console.log(`PASS ${pass} · FAIL ${fail}`)
  if (fail > 0) {
    console.log('Failures:\n  ' + failures.join('\n  '))
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error('suite crashed:', err)
  process.exit(1)
})

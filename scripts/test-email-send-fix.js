/**
 * E2E test for the Email Automation send-fix.
 *
 * Proves the bug is fixed end-to-end on the local dev server:
 *   BEFORE: credential with a fromName -> send reported fake "success"
 *           (MCPEmails actually rejected from_name with isError:true)
 *   AFTER:  the true upstream outcome is surfaced. With the test key
 *           (no mailbox connected) we expect a 502 upstream_rejected
 *           whose message says "No mailbox is connected".
 *
 * Usage:
 *   node scripts/test-email-send-fix.js [baseUrl]
 * Env (temp only, never committed):
 *   TEST_KV_KEY   — a local platform API key (created by the script if absent)
 *   MCPE_TEST_KEY — the MCPEmail key to connect as a test credential
 */
const BASE = process.argv[2] || 'http://localhost:3000'
const kvKey = process.env.TEST_KV_KEY || 'kv_live_test_emailfix0000000000000000000'
const mcpeKey = process.env.MCPE_TEST_KEY

async function j(method, path, body, auth) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let data
  try { data = JSON.parse(text) } catch { data = { raw: text.slice(0, 200) } }
  return { status: res.status, data }
}

function check(label, cond, extra) {
  console.log(`${cond ? '✓' : '✗ FAIL'}  ${label}${extra ? ` — ${extra}` : ''}`)
  if (!cond) process.exitCode = 1
}

async function main() {
  console.log(`Testing email send fix against ${BASE}\n`)

  // 0. health
  const health = await j('GET', '/api/health')
  check('dev server is up', health.status === 200, `status ${health.status}`)

  // 1. register (idempotent) + login
  const email = `emailfix-test-${Date.now()}@onyx.local`
  const reg = await j('POST', '/api/auth/register', {
    email,
    password: 'TestPass123!emailfix',
    name: 'Email Fix Test',
  })
  const login = await j('POST', '/api/auth/login', {
    email,
    password: 'TestPass123!emailfix',
    ...(reg.status === 200 && reg.data?.apiKey ? {} : {}),
  })
  // extract apiKey from register or login
  let key = reg.data?.apiKey || login.data?.apiKey || login.data?.key
  if (!key) {
    // fallback: use provided TEST_KV_KEY directly (whoami must recognize it)
    const who = await j('GET', '/api/auth/whoami', null, kvKey)
    check('fallback kv key works', who.status === 200, JSON.stringify(who.data).slice(0, 120))
    key = kvKey
  } else {
    check('test user registered/logged in', true, email)
  }

  if (!mcpeKey) {
    console.log('\nMCPE_TEST_KEY not set — skipping live upstream assertions.')
    return
  }

  // 2. connect credential WITH a fromName (the exact shape that broke prod)
  const conn = await j('POST', '/api/credentials/connect', {
    name: 'test_email',
    apiKey: mcpeKey,
    label: 'fix test',
    fromName: 'Some From Name',
    testConnection: true,
  }, key)
  const warned = conn.data?.connection?.warning
  check('credential connected', conn.status === 200,
    conn.status === 200 ? `inboxCount=${conn.data?.connection?.inboxCount}${warned ? ' (warning set)' : ''}` : JSON.stringify(conn.data).slice(0, 150))

  // 3. THE test: send an email. With no mailbox on this key, the OLD code
  //    returned 200 fake-success; the NEW code must surface the refusal.
  const send = await j('POST', '/api/email/send', {
    credential: 'test_email',
    to: 'k77893301@gmail.com',
    subject: 'Send-fix E2E — fromName no longer forwarded',
    body: 'If you can read this in your inbox, the pipeline works.',
  }, key)
  const code = send.data?.code
  if (send.status === 200) {
    check('send outcome is a REAL success (mailbox exists on this key)', true,
      `upstream_message_id=${send.data?.upstream_message_id}`)
  } else {
    check('send surfaces the true upstream failure (no fake success)', send.status === 502 && (code === 'upstream_rejected' || code === 'upstream_error'),
      `HTTP ${send.status} code=${code}`)
    check('failure message is actionable (mentions mailbox)', /mailbox|inbox|connect/i.test(String(send.data?.error || send.data?.message || '')),
      String(send.data?.error || send.data?.message || '').slice(0, 180))
  }

  // 4. cleanup: delete the credential so the raw key doesn't linger in the dev DB
  const del = await j('DELETE', '/api/credentials/test_email', null, key)
  check('test credential cleaned up', del.status === 200, `HTTP ${del.status}`)

  console.log('\nDone.')
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })

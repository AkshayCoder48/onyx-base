#!/usr/bin/env node
/** Smoke-test every dashboard sidebar tab's API endpoint.
 * Usage: node scripts/test-all-tabs.js
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000'
const KEY = process.env.ONYX_KEY || 'kv_live_XXXXXXXXXXXXXXXXXXX'

const H = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }

// [tab, method, path, body?]
const CASES = [
  ['overview',      'GET',  '/api/dashboard/stats'],
  ['overview',      'GET',  '/api/dashboard/records?'],
  ['overview',      'GET',  '/api/dashboard/analytics'],
  ['database',      'GET',  '/api/dashboard/collections'],
  ['database',      'GET',  '/api/dashboard/records?'],
  ['database',      'GET',  '/api/dashboard/export'],
  ['collections',   'GET',  '/api/dashboard/collections'],
  ['storage',       'GET',  '/api/files'],
  ['api-keys',      'GET',  '/api/dashboard/api-keys'],
  ['email-otp',     'GET',  '/api/dashboard/mcpemail-config'],
  ['email-otp',     'POST', '/api/email-otp/send', { email: 'smoke-test@example.invalid' }],
  ['share',         'GET',  '/api/dashboard/share-tokens'],
  ['logs',          'GET',  '/api/dashboard/logs'],
  ['analytics',     'GET',  '/api/dashboard/analytics'],
  ['sql',           'POST', '/api/dashboard/sql', { query: 'SELECT COUNT(*) AS n FROM kv' }],
  ['tables',        'GET',  '/api/dashboard/tables'],
  ['docs',          'GET',  '/api/docs'],
  ['settings',      'GET',  '/api/dashboard/stats'],
  ['settings',      'GET',  '/api/dashboard/status'],
  ['settings',      'GET',  '/api/dashboard/telegram-config'],
  ['diagnostics',   'GET',  '/api/health'],
  ['diagnostics',   'GET',  '/api/dashboard/diagnostics/queue'],
  ['diagnostics',   'GET',  '/api/dashboard/status?forceProbe=1'],
  // core v1 API surface
  ['v1 core',       'GET',  '/api/v1/health'],
  ['v1 core',       'GET',  '/api/v1/stats'],
  ['v1 core',       'GET',  '/api/v1/whoami'],
  ['v1 core',       'GET',  '/api/v1/list'],
  ['v1 core',       'GET',  '/api/v1/collections'],
  ['v1 core',       'GET',  '/api/v1/tables'],
  ['v1 core',       'GET',  '/api/v1/views'],
  ['v1 core',       'GET',  '/api/v1/matviews'],
  ['v1 core',       'GET',  '/api/v1/functions'],
  ['v1 core',       'GET',  '/api/v1/logs'],
  ['v1 core',       'GET',  '/api/openapi.json'],
]

async function main() {
  let fail = 0
  for (const [tab, method, path, body] of CASES) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: H,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      let snippet = text.slice(0, 120).replace(/\s+/g, ' ')
      const ok = res.ok
      if (!ok) fail++
      console.log(`${ok ? 'OK  ' : 'FAIL'} [${res.status}] ${tab.padEnd(12)} ${method.padEnd(4)} ${path}  → ${snippet}`)
    } catch (err) {
      fail++
      console.log(`FAIL [ err] ${tab.padEnd(12)} ${method.padEnd(4)} ${path}  → ${err.message}`)
    }
  }
  console.log(`\n${CASES.length - fail}/${CASES.length} passed, ${fail} failed`)
  process.exit(fail > 0 ? 1 : 0)
}
main()

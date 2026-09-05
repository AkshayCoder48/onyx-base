#!/usr/bin/env node
/** Smoke-test every dashboard sidebar tab's API endpoint.
 * Usage: node scripts/test-all-tabs.js
 */
const BASE = process.env.BASE_URL || 'http://localhost:3000'
const KEY = process.env.ONYX_KEY || ''

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
  ['email-automation', 'GET',  '/api/credentials'],
  ['email-automation', 'GET',  '/api/telegram/config'],
  // 404 `credential_not_found` is the correct response for an unknown
  // credential name — it proves the fail-closed rule (no project fallback).
  ['email-automation', 'POST', '/api/email/send', { credential: 'no_such_credential', to: 'smoke-test@example.invalid', subject: 'hi', body: 'hi' }, 404],
  ['share',         'GET',  '/api/dashboard/share-tokens'],
  ['logs',          'GET',  '/api/dashboard/logs'],
  ['analytics',     'GET',  '/api/dashboard/analytics'],
  ['sql',           'POST', '/api/dashboard/sql', { sql: 'SELECT 1 AS n' }, 200],
  ['tables',        'GET',  '/api/dashboard/tables'],
  ['docs',          'GET',  '/api/docs'],
  ['settings',      'GET',  '/api/dashboard/stats'],
  ['settings',      'GET',  '/api/dashboard/status'],
  ['settings',      'GET',  '/api/dashboard/telegram-config'],
  ['diagnostics',   'GET',  '/api/health'],
  ['diagnostics',   'GET',  '/api/dashboard/diagnostics/queue'],
  ['diagnostics',   'GET',  '/api/dashboard/status?forceProbe=1'],
  // core v1 API surface (root-level /v1/* — NOT /api/v1/*)
  ['v1 core',       'GET',  '/v1/health'],
  ['v1 core',       'GET',  '/v1/stats'],
  ['v1 core',       'GET',  '/v1/whoami'],
  ['v1 core',       'GET',  '/v1/list'],
  ['v1 core',       'GET',  '/v1/collections'],
  ['v1 core',       'GET',  '/v1/tables'],
  ['v1 core',       'GET',  '/v1/logs'],
  // advanced endpoints exist under /api/v1/* as well
  ['v1 advanced',   'GET',  '/api/v1/views'],
  ['v1 advanced',   'GET',  '/api/v1/matviews'],
  ['v1 advanced',   'GET',  '/api/v1/functions'],
  ['v1 core',       'GET',  '/api/openapi.json'],
  // public docs — must work WITHOUT auth (anonymous)
  ['docs public',   'GET',  '/docs'],
  ['docs public',   'GET',  '/api/openapi.json'],
]

async function main() {
  let fail = 0
  for (const [tab, method, path, body, expected] of CASES) {
    // "docs public" cases must be fetched WITHOUT the auth header.
    const anonymous = tab === 'docs public'
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: anonymous ? undefined : H,
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      const snippet = text.slice(0, 120).replace(/\s+/g, ' ')
      const ok = expected !== undefined ? res.status === expected : res.ok
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

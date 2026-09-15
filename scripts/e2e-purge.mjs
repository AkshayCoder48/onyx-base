#!/usr/bin/env node
/**
 * E2E test-data purge against PRODUCTION (deterministic, explicit ids only).
 *
 * Usage: node scripts/e2e-purge.mjs [--execute]
 *   default = dry-run (resolves + reports, deletes NOTHING)
 *   --execute = really deletes via POST /api/v5/admin/purge
 *
 * Identification is DETERMINISTIC (PRD §18): every target is an explicit
 * id/email/key enumerated from the inventory — never a name pattern.
 * Real users (profiles, follows, their OTPs, their op records, the real
 * community post, admin audit log, sessions, the onyxagent app's workspace
 * data) are NEVER touched.
 */
const BASE = 'https://onyxbase-chi.vercel.app'
const KEY = process.env.V5_MASTER_KEY
if (!KEY) {
  console.error('V5_MASTER_KEY env required')
  process.exit(1)
}
const EXECUTE = process.argv.includes('--execute')

/** Whole collections that are 100% e2e/verification debris (owner=master). */
const WIPE_COLLECTIONS = [
  'default', // bench-write-*, diag/envcheck/pace/throttle/yield probes
  'e2e',
  'accept',
  'diag',
  'verify1', 'verify2', 'verify3', 'verify_big', 'verify_cache', 'verify_dash',
  'verify_fix', 'verify_fix2', 'verify_fix3', 'verify_fix4', 'verify_fix5',
  'verify_fix6', 'verify_fix7', 'verify_fix8', 'verify_fix9', 'verify_fix10',
  'verify_quiet', 'verify_size', 'verify_tiny',
  'upload_chunks', // stale legacy chunked-upload sessions (e2e videos)
  'resource_bytes', // orphaned durable image shards (no image records remain)
  'rge_tombs', // tomb:img_e2etest2
  'rge_index', // probe_arr
]

/** Explicit extra keys inside live collections (partial wipes). */
const EXTRA_KV = [
  // onyxagent test probes (workspace:*/schedule:* are ANOTHER app's data — kept)
  { owner: 'master', collection: 'onyxagent', key: 'probe:b64gzip' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:conc:02' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:conc:09' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:rate' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:size128000' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:size256000' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:size32000' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:size64000' },
  { owner: 'master', collection: 'onyxagent', key: 'probe:size8k' },
  // test-signup / malformed-email OTP debris (real users' OTPs are kept)
  { owner: 'master', collection: 'otps', key: 'otp:@rallbroedltz679gmail.com:password_reset' },
  { owner: 'master', collection: 'otps', key: 'otp:@rallbroedltz679gmail.com:registration' },
  { owner: 'master', collection: 'otps', key: 'otp:lovabletest121@gmail.com:registration' },
  { owner: 'master', collection: 'otps', key: 'otp:sakshamxeditz@gmailmcom:registration' },
  // auth op records of the four test accounts (real users' ops kept)
  { owner: 'master', collection: 'rge_ops_login', key: 'cookie-test-1' },
  { owner: 'master', collection: 'rge_ops_login', key: 'final-login-001' },
  { owner: 'master', collection: 'rge_ops_login', key: 'e49ecd27-5614-4d4b-bde4-b7169d1e4768' },
  { owner: 'master', collection: 'rge_ops_register', key: 'e2e-reg-1789444023' },
  { owner: 'master', collection: 'rge_ops_register', key: 'final-reg-001' },
  { owner: 'master', collection: 'rge_ops_register', key: 'final-reg-002' },
  { owner: 'master', collection: 'rge_ops_register', key: '68fae818-b921-4e4a-9bfe-b1d40804921a' },
  // orphaned dedup keys (their blobs were removed by the prior surgery)
  { owner: 'master', collection: 'v5_blobmeta', key: 'sum:80c4afea2ff7307921b705b52b23220ec82427d45785bde40aa68e6559faaa0e' },
  { owner: 'master', collection: 'v5_blobmeta', key: 'sum:ce59bcad722d37c1202bb1ff58b2f2fd72473860ab6362d2c81485de0c58ac73' },
]

/** Unambiguous e2e test accounts (harness domains / plus-alias / test names).
 *  Real-email accounts (aiworks77888@gmail.com, akshayhello67@gmail.com,
 *  k77893301@gmail.com) are KEPT — deleting a real user's login is never
 *  part of test cleanup. */
const ACCOUNTS = [
  'usr_8eeefb55db', // v5test@railguyedits.dev "V5 Test"
  'usr_242fb28870', // v5final@railguyedits.dev "V5 Final"
  'usr_fb0600e849', // durable-verify-…@rge-test.local "Durable Verify"
  'usr_68a8dc161e', // aiworks77888+fresh1@gmail.com "Fresh Test User"
]

/** Blobs (the only surviving row is the e2e timeline xml). */
const BLOBS = ['blb_b4a68b64d45a62625659734f'] // e2e-timeline.xml

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok || body?.ok === false) {
    throw new Error(`${init?.method || 'GET'} ${path} -> ${res.status}: ${JSON.stringify(body).slice(0, 200)}`)
  }
  return body.data
}

async function main() {
  // 1. Enumerate keys of the wipe collections (explicit, reviewed below).
  const kv = [...EXTRA_KV]
  console.log('== Enumerating wipe collections ==')
  for (const c of WIPE_COLLECTIONS) {
    const d = await api(`/api/v5/admin/purge?collection=${encodeURIComponent(c)}&owner=master`)
    for (const it of d.items) kv.push({ owner: 'master', collection: c, key: it.key })
    console.log(`  ${c}: ${d.items.length} keys`)
  }

  // 2. SANITY GATE — two tiers:
  //    a) SHARED-NAME collections (default/upload_chunks/resource_bytes/
  //       rge_tombs/rge_index) could in principle hold a stray real key, so
  //       EVERY key there must match the known debris vocabulary.
  //    b) verify*/e2e/accept/diag collections are test debris BY NAME —
  //       their keys are wiped wholesale, but all are printed above for
  //       review before --execute.
  const GATED = ['default', 'upload_chunks', 'resource_bytes', 'rge_tombs', 'rge_index']
  const VOCAB = /^(bench-write-|diag_|envcheck_|pace_probe_|throttle_probe_|yield_probe_|surgery_probe|accept_par_|fixverify_|gzipcheck_|netcheck_|phantom_watch|probe_arr|tomb:img_e2etest2|chunk:|rb:|probe:)/
  const unexpected = kv.filter(
    (e) => GATED.includes(e.collection) && !VOCAB.test(e.key)
  )
  if (unexpected.length > 0) {
    console.error('\nABORT — unexpected keys in gated collections (review before proceeding):')
    for (const e of unexpected) console.error(`  ${e.collection}/${e.key}`)
    process.exit(1)
  }

  const payload = { dryRun: !EXECUTE, accounts: ACCOUNTS, blobs: BLOBS, kv }
  console.log(`\n== ${EXECUTE ? 'EXECUTING' : 'DRY RUN'} ==`)
  console.log(`  accounts: ${ACCOUNTS.length}, blobs: ${BLOBS.length}, kv keys: ${kv.length}`)

  const out = await api('/api/v5/admin/purge', { method: 'POST', body: JSON.stringify(payload) })
  console.log(JSON.stringify(out, null, 2))
}

main().catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})

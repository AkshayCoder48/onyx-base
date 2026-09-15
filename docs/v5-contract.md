# OnyxBase V5 — Instant Architecture Contract (FROZEN)

Owner: AkshayCoder48. This document is the single source of truth for the V5 build.
Both the onyx-base V5 backend and the rge-hub client code against EXACTLY these shapes.

## Design principle (PRD final rule)

If the server committed the operation, the client must be able to discover that
fact — even if the original response was lost. If it hasn't committed, the UI
must say so. NO fake frontend states. NO generic "server busy".

## Storage engine

- Driver: `@libsql/client` (single dependency, works in Bun/Node/serverless).
- `V5_DATABASE_URL`:
  - `file:./.data/v5.db` → local SQLite (self-host / dev) — WAL, prepared stmts.
  - `libsql://<dbname>-<org>.turso.io` + `V5_DATABASE_AUTH_TOKEN` → Turso (Vercel).
- SQLite is AUTHORITATIVE for V5. Telegram becomes an ASYNC durability mirror
  (background, fire-and-forget, retried) — never in the request path.
- Writes commit in one transaction; response returns only after local commit
  (sub-10ms typical). Durability to Telegram rides behind `after()`/setTimeout.

## Schema (DDL — v5 module owns these tables, V4 Prisma tables untouched)

```sql
CREATE TABLE IF NOT EXISTS v5_accounts (
  id TEXT PRIMARY KEY,               -- account id (usr_… / acc_…)
  owner_key TEXT NOT NULL,           -- for the master/service account: 'master'
  api_key_hash TEXT NOT NULL,        -- sha256hex(api_key + V5_KEY_SALT)
  email TEXT,
  email_lower TEXT,                  -- lowercased, UNIQUE when not null
  password_hash TEXT,                -- scrypt/bcrypt (reuse src/lib/password.ts)
  name TEXT,
  role TEXT NOT NULL DEFAULT 'user', -- user | admin
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS v5_accounts_key ON v5_accounts(api_key_hash);
CREATE UNIQUE INDEX IF NOT EXISTS v5_accounts_email ON v5_accounts(email_lower) WHERE email_lower IS NOT NULL;

CREATE TABLE IF NOT EXISTS v5_kv (
  owner TEXT NOT NULL,               -- account id (or 'master' for the service account)
  collection TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT NOT NULL,               -- JSON
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,                -- tombstone epoch ms; NULL = live
  PRIMARY KEY (owner, collection, key)
);
CREATE INDEX IF NOT EXISTS v5_kv_scan ON v5_kv(owner, collection, deleted_at, updated_at DESC);
-- prefix scans use the same PK (owner, collection, key prefix range)

CREATE TABLE IF NOT EXISTS v5_counters (
  owner TEXT NOT NULL,
  name TEXT NOT NULL,                -- e.g. 'kv:profiles:live'
  value INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner, name)
);

CREATE TABLE IF NOT EXISTS v5_ops (
  id TEXT PRIMARY KEY,               -- operationId UUID
  owner TEXT NOT NULL,
  type TEXT NOT NULL,                -- 'kv.set' | 'blob.finalize' | 'rge.auth.register' | …
  idem_key TEXT,                     -- client Idempotency-Key / requestId
  status TEXT NOT NULL DEFAULT 'processing',  -- processing|completed|failed
  request_json TEXT,
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  duration_ms INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS v5_ops_idem ON v5_ops(owner, type, idem_key) WHERE idem_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS v5_ops_recent ON v5_ops(owner, updated_at DESC);

CREATE TABLE IF NOT EXISTS v5_blobs (
  id TEXT PRIMARY KEY,               -- canonical blob id (fileId-compatible)
  owner TEXT NOT NULL,
  filename TEXT,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  checksum TEXT,                     -- sha256 hex once known
  status TEXT NOT NULL DEFAULT 'created', -- created|uploading|uploaded|finalizing|ready|failed|cancelled
  storage_key TEXT,                  -- staging path / telegram chunk-set id
  chunks INTEGER NOT NULL DEFAULT 0,
  is_public INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v5_blobs_owner ON v5_blobs(owner, status, created_at DESC);

CREATE TABLE IF NOT EXISTS v5_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  type TEXT NOT NULL,                -- KV_SET|KV_DELETED|BATCH_SET|BLOB_STATUS|ACCOUNT_CREATED
  subject TEXT,                      -- 'collection/key' or blobId
  payload TEXT,                      -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS v5_events_owner ON v5_events(owner, id);
```

Pragmas on file mode: WAL, synchronous=NORMAL, busy_timeout=5000.

## Auth

- Data endpoints: `Authorization: Bearer <api_key>` — resolved by ONE indexed
  lookup on v5_accounts.api_key_hash. The env master key (same env var the V4
  app uses for its master key) is seeded as the `master` service account on
  first boot (idempotent). V5 auth NEVER waits for Telegram rehydration.
- Public (no bearer): account register/login, health, operations lookup by
  idem key ONLY with the owner's bearer (lookup is authenticated).
- Multiple api keys per account are allowed: mint a new row (same owner).

## REST surface (all responses: {ok:true,data} | {ok:false,error,code,requestId,durationMs})

1. `GET  /api/v5/kv/:key?collection=default`
   → 200 `{key, collection, value, updatedAt}` | 404 code NOT_FOUND
2. `PUT|POST /api/v5/kv/:key`  body `{value, collection?}` header `Idempotency-Key?`
   → 200 `{key, collection, value, updatedAt, committed:true}`
   - value JSON ≤ 256 KB (else 413 PAYLOAD_TOO_LARGE, use blobs)
   - replays: same Idempotency-Key → return stored response w/ `replayed:true`
   - concurrent same key → 409 IDEMPOTENCY_IN_FLIGHT {retryable:true}
3. `DELETE /api/v5/kv/:key?collection=` → 200 `{key, deleted:true}` (idempotent tombstone)
4. `POST /api/v5/kv/batch` body `{collection?, items:[{key,value}]}` ≤ 500 items, one tx
   → 200 `{count, committed:true}`
5. `GET  /api/v5/kv?collection=&prefix=&limit=100&offset=0` (limit ≤ 1000)
   → 200 `{items:[{key,value,updatedAt}], total, limit, offset, hasMore}`
6. `GET  /api/v5/export?collection=&limit=&offset=` — alias of 5 (migration/backup)
7. `POST /api/v5/accounts` body `{name, email, password}` header `Idempotency-Key?`
   → 200 `{userId, apiKey, name, email}` (apiKey shown once; idem replay mints a fresh key for the same account) | 409 EMAIL_TAKEN
8. `POST /api/v5/accounts/login` body `{email, password}`
   → 200 `{userId, apiKey, name, email}` | 401 AUTH_INVALID_CREDENTIALS
   (login mints a fresh api key — keys are not recoverable, only re-mintable)
9. `GET  /api/v5/operations/:id` → 200 `{id, status, type, result?, error?, createdAt, updatedAt, durationMs}` | 404
10. `POST /api/v5/operations/lookup` body `{type, idemKey}` (auth: owner) → same as 9 | 404
11. `POST /api/v5/blobs` body `{filename?, mimeType?, size?}` → 200 `{blobId, status:'created', chunkSize, maxChunks}` (chunkSize 4 MiB, maxChunks 10000 → 40 GiB)
12. `PUT  /api/v5/blobs/:id/data[?chunk=N&total=N]` raw body bytes
    - streamed: read request body sequentially, slice into chunks, write staging
      (local dir) or send straight to Telegram chunks — NEVER buffer whole body in RAM
    - last chunk auto-transitions status uploaded; intermediate → uploading
    → 200 `{blobId, status, received}`
13. `POST /api/v5/blobs/:id/finalize` → 200 `{blobId, status:'ready'|'finalizing', operationId?}`
    - local staging verifiable + Telegram pin queued async → 'ready' when the
      durable copy is confirmed OR immediately when V5_TELEGRAM_BACKUP=false
    - emits BLOB_STATUS ready event; op record for the finalize job
14. `GET  /api/v5/blobs/:id` → 200 `{blobId, filename, mimeType, size, checksum, status, storageKey, publicUrl, createdAt, updatedAt}`
    publicUrl = `${PUBLIC_BASE_URL}/f/{blobId}`
15. `GET  /api/v5/blobs/:id/content` → stream, ETag=checksum, immutable when ready; 409 `{code:'BLOB_NOT_READY', status}` otherwise
16. `POST /api/v5/blobs/:id/cancel` → 200 `{blobId, status:'cancelled'}`
17. `GET  /api/v5/events?since=<id>&types=&limit=100` → 200 `{events:[…], cursor}`
18. `GET  /api/v5/realtime` SSE: `event: v5\ndata:{type,subject,payload}` + 15s heartbeat, close ≤ 50s (clients MUST fall back to poll 17)
19. `GET  /api/v5/health` → `{status, db:{ok, latencyMs}, blobBackend, telegramBackup}`
    `GET /api/v5/health/ready`
20. `POST /api/v5/admin/migrate` (master/admin) body `{source?:{baseUrl,apiKey}, collections?:string[], dryRun?}`
    - default source: local V4 store; remote: HTTP export from a V4 instance
    - upserts v5_kv rows; returns per-collection counts; idempotent
21. `GET  /api/v5/stats` → maintained per-collection live counts + blob counts

Public file URL `/f/:blobId` must serve V5 blob content (V4-compatible route
shape RGE Hub already links against).

## Blob status machine

created → uploading → uploaded → finalizing → ready
Any → failed (error) / cancelled. failed → retry finalize allowed.

## Events (also drive server cache invalidation)

KV_SET, KV_DELETED, BATCH_SET, BLOB_STATUS, ACCOUNT_CREATED.
Payloads are small metadata ONLY (never values > 1 KB).

## Error codes (never a generic "server busy")

NOT_FOUND, VALIDATION_ERROR, AUTH_REQUIRED, AUTH_INVALID_CREDENTIALS,
EMAIL_TAKEN, RATE_LIMITED, IDEMPOTENCY_IN_FLIGHT, PAYLOAD_TOO_LARGE,
BLOB_NOT_READY, STORAGE_UNAVAILABLE, DATABASE_UNAVAILABLE, UNKNOWN_ERROR.

## Env (onyx-base)

- V5_DATABASE_URL (required for V5; missing → V5 routes 503 DATABASE_UNAVAILABLE)
- V5_DATABASE_AUTH_TOKEN (Turso only)
- V5_TELEGRAM_BACKUP (default true)
- V5_BLOB_STAGING_DIR (default ./.data/v5-blobs)
- V5_KEY_SALT (default: derive from existing app secret env or fixed dev salt)
- Existing TELEGRAM_* / master-key envs are reused, untouched.

## RGE Hub side (client contract)

- Env: `ONYXBASE_V5_URL` (e.g. https://onyxbase-chi.vercel.app or http://localhost:3001).
  Set → kv/file primitives in src/lib/onyxbase.ts route to /api/v5/* (fast path).
  Unset → existing V4 behavior, byte-identical (rollback safety).
- Registration (the reported bug):
  - Client sends `requestId` (UUID, stable across auto-retries of one attempt).
  - Server flow (V5 mode): ops lookup (type 'rge.auth.register', idemKey=requestId)
    → completed ⇒ re-issue session, 200 `{ok:true, status:'authenticated', user, recovered:true}`
    → fresh: create v5 account + profile kv + indexes + op record (fast), session, 200.
  - Account exists + no op record ⇒ 409 `EMAIL_ALREADY_REGISTERED` with
    `{hint:'sign-in'}` — the UI then routes to login (prefilled email). A valid
    OTP holder ALWAYS gets a session — "already registered" never dead-ends.
- Login: same requestId idempotency; get-or-create profile; session.
- Frontend states: idle | submitting | success | failed ONLY. On timeout:
  auto-retry SAME requestId (≤2 retries, 1s/3s backoff) → then GET /api/auth/me
  reconcile → then honest failed state with [Try again] [Sign in instead].
  The copy "you will be signed in shortly" is DELETED everywhere.

## Performance targets (PRD §25)

- Reads p95 < 500 ms; mutations p95 < 1 s; auth ops p95 < 1 s (excl. email);
  upload init p95 < 500 ms. Local SQLite: expect p95 < 50 ms.

## Cross-instance freshness (file mode) — Telegram as the convergence point

`src/lib/v5/sync.ts`. File-mode deployments give every serverless instance its
own ephemeral SQLite (`file:/tmp/v5.db`); boot-restore hydrates EMPTY stores
only, so an instance that booted before another instance's writes would serve
stale data forever (register on A → login routed to B → invalid credentials).

The shared snapshot pointer (bot bio → pinned V4 index fallback) is the
watermark that converges instances:

1. **Probe loop** — every 20 s per warm instance, ONE cheap pointer read
   (`getMyDescription`). Newer `ts` than this instance last applied ⇒ download
   + apply the snapshot (kv upserts are `updated_at`-conditional — local newer
   writes always win; accounts/blobs insert-if-absent). Remote mode never
   probes (one shared DB).
2. **Miss probes** — login lookup miss, register email-uniqueness miss, bearer
   miss, kv `GET` miss and `/f/[id]` blob miss trigger ONE rate-limited probe
   (min 2 s spacing per instance, coalesced in-flight) + local retry before
   reporting NOT_FOUND / AUTH_INVALID_CREDENTIALS. Cross-instance reads
   self-heal in seconds instead of one loop cadence.
3. **Auth snapshots** — register / login-key-mint / idempotent-replay call
   `backup.queueAuthSnapshot()` (≥5 s spacing per instance): an immediate
   async full-state snapshot so other instances converge ~1-2 s after a
   registration.
4. **Idle snapshots** — the mirror drain snapshots after ≥10 mirrored writes
   OR ≥1 write with the last snapshot ≥15 s old.
5. **Monotonicity guard** — `uploadV5Snapshot` probes + applies any newer
   shared snapshot BEFORE reading rows, so an upload is always a superset (a
   stale instance can never regress the shared pointer).

Restore additionally rebuilds `v5_counters` from table state and drops the
per-key hot cache (`kv.clearKvCache`), so post-apply reads never serve a
pre-restore row or a cached negative.

Degradation contract: Telegram unreachable ⇒ probes fail fast (4 s timeout),
auth/kv stay instant against the local store, and outcomes remain honest
(invalid credentials / NOT_FOUND) — no hangs, no fake states. Health exposes
`freshness: {active, lastProbeAt, lastProbeOk, lastAppliedSnapshotTs}`.

Residual window (documented, accepted): same email registered on two
instances within the ~2 s convergence window can produce a split-brain that
the next snapshot merge heals on the kv layer; the accounts unique index
makes it impossible within one instance, and RGE Hub's stable-requestId
retries make the client side idempotent. For strict multi-instance
transactionality, use remote mode (`V5_DATABASE_URL=libsql://…`).

## Durable background work (serverless freeze fix) — src/lib/v5/durable.ts

Vercel may freeze a function the moment its response ships. Fire-and-forget
promises die mid-flight: the auth snapshot after a registration never reached
Telegram, the account existed only on the instance that created it, and the
next login on another instance honestly answered AUTH_INVALID_CREDENTIALS.

`durable(p)` (from `@vercel/functions` `waitUntil`) registers the promise on
the CURRENT invocation: the platform keeps the function alive until it
settles, bounded by the route's `maxDuration` (60 s on all write-capable V5
routes). The HTTP response is NOT delayed. Non-Vercel environments never
freeze mid-task — `durable()` degrades to a plain void there.

Durable-wrapped paths:
- `backup.queueAuthSnapshot()` — the post-register/login full-state snapshot
- `mirror.armDrain()` — one durable cycle per drain: paced Telegram audit
  sends + the idle full-state snapshot that follows (jobs enqueued while a
  cycle closes chain a fresh cycle in the same slot)
- `sync.maybeBackgroundProbe()` — 10 s/instance background pointer probe from
  every authenticated request (bounds STALE HITS; miss paths probe inline)

Rules: call `durable()` synchronously within the request's async context, and
the wrapped promise must never reject.

Restore hardening: accounts/blobs apply with `INSERT OR IGNORE` and the
snapshot SELECTs use `ORDER BY created_at ASC` — in the rare split-brain
window (same email registered on two instances before convergence), the
EARLIEST account wins on the email_lower unique index instead of aborting
the apply batch.

v5Register also re-checks the IDEM REPLAY after the freshness probe (a
same-requestId retry landing on a just-converged instance replays the
original account instead of colliding with EMAIL_TAKEN).

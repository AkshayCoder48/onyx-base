import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

/**
 * GET /api/openapi.json
 *
 * Returns an OpenAPI 3.0 spec covering the /v1/* and /api/auth/* endpoints.
 * Used by /api/docs (Swagger UI) and any OpenAPI-compatible client.
 *
 * The spec is hand-written to stay in sync with the actual routes. Bearer
 * auth (kv_live_* or onyxbase_*) is declared as a security scheme.
 */

const SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'Onyx Base API',
    version: '1.0.0',
    description:
      'Telegram-backed key-value & file store. A lightweight Supabase-style developer platform — SQLite is the fast local index, Telegram is the durable mirror. Bring a Bot Token + Chat ID (or use the built-in server-side bot) → get a key-value database AND a file store, plus a real-time dashboard, REST API, and a zero-dependency CLI.',
    contact: { name: 'Onyx Base', url: 'https://llmstxt.org' },
  },
  servers: [{ url: '/', description: 'Relative to deployment root' }],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'kv_live_<hex> | onyxbase_<hex>',
        description:
          'API key. Regular users use `kv_live_*`; admins use `onyxbase_*`. Pass as `Authorization: Bearer <key>`.',
      },
    },
    schemas: {
      Ok: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
        },
        required: ['ok'],
      },
      Error: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: false },
          error: { type: 'string' },
        },
        required: ['ok', 'error'],
      },
      Record: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: {},
          valueType: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array', 'null'] },
          collection: { type: 'string' },
          updatedAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['key', 'value', 'valueType', 'collection'],
      },
      User: {
        type: 'object',
        properties: {
          userId: { type: 'string', example: 'usr_8d72a' },
          name: { type: 'string', nullable: true },
          email: { type: 'string', nullable: true },
          plan: { type: 'string', enum: ['free', 'pro', 'team', 'unlimited'] },
          isAdmin: { type: 'boolean' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['userId'],
      },
      ApiKey: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          key: { type: 'string', description: 'Masked — first 12 + last 4 chars.' },
          revoked: { type: 'boolean' },
          lastUsedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Log: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string' },
          key: { type: 'string', nullable: true },
          detail: { type: 'string', nullable: true },
          source: { type: 'string' },
          ip: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      View: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          collection: { type: 'string' },
          projection: { type: 'string' },
          filter: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['name', 'collection', 'projection'],
      },
      Function: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          code: { type: 'string' },
          trigger: { type: 'string' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['name', 'code'],
      },
      MaterializedView: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          query: { type: 'string' },
          result: {}, // JSON-parsed on read
          lastRefreshedAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
        },
        required: ['name', 'query'],
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    // ─── Auth ──────────────────────────────────────────────────────────────
    '/api/auth/register': {
      post: {
        summary: 'Create a new developer account',
        description: 'Returns a `kv_live_*` API key. No auth required.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  email: { type: 'string', format: 'email' },
                  source: { type: 'string', enum: ['web', 'cli'] },
                },
              },
            },
          },
        },
        responses: {
          '200': { description: 'Account created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Ok' } } } },
          '400': { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/auth/login': {
      post: {
        summary: 'Sign in with email + password',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { email: { type: 'string' }, password: { type: 'string' } }, required: ['email', 'password'] } } } },
        responses: { '200': { description: 'OK' }, '401': { description: 'Invalid credentials' } },
      },
    },
    '/api/auth/verify': {
      post: {
        summary: 'Verify an API key is valid + non-revoked',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { apiKey: { type: 'string' } }, required: ['apiKey'] } } } },
        responses: { '200': { description: 'OK' }, '401': { description: 'Invalid or revoked' } },
      },
    },
    '/api/auth/whoami': {
      get: { summary: 'Verify the bearer key + show user', responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } } },
    },
    '/api/auth/recover': {
      post: { summary: 'Recover a lost key via email + password', security: [], responses: { '200': { description: 'OK' } } },
    },

    // ─── Key-Value REST ───────────────────────────────────────────────────
    '/v1/set': {
      post: {
        summary: 'Upsert a key/value (auto-typed)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { key: { type: 'string' }, value: {}, collection: { type: 'string' } }, required: ['key', 'value'] } } } },
        responses: { '200': { description: 'Record stored', content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } } }, '401': { description: 'Unauthorized' } },
      },
    },
    '/v1/get/{key}': {
      get: {
        summary: 'Read one value (404 if missing)',
        parameters: [
          { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'collection', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { $ref: '#/components/schemas/Record' } } } }, '404': { description: 'Not found' } },
      },
    },
    '/v1/delete/{key}': {
      delete: {
        summary: 'Remove a key + Telegram mirror',
        parameters: [
          { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'collection', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } },
      },
    },
    '/v1/list': {
      get: {
        summary: 'List keys (compact)',
        parameters: [{ name: 'collection', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/export': {
      get: {
        summary: 'Dump {key: value} as JSON',
        parameters: [{ name: 'collection', in: 'query', schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/v1/collections': {
      get: { summary: 'List collections', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Create a named collection', responses: { '200': { description: 'OK' } } },
    },
    '/v1/collections/{name}': {
      delete: { summary: 'Delete a collection + all its records', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },
    '/v1/whoami': { get: { summary: 'Verify API key + show counts', responses: { '200': { description: 'OK' } } } },
    '/v1/health': { get: { summary: 'Service health check', responses: { '200': { description: 'OK' } } } },
    '/v1/stats': { get: { summary: 'Usage statistics', responses: { '200': { description: 'OK' } } } },
    '/v1/logs': { get: { summary: 'Recent activity logs', responses: { '200': { description: 'OK' } } } },

    // ─── Files ───────────────────────────────────────────────────────────
    '/v1/files': {
      get: { summary: 'List files', responses: { '200': { description: 'OK' } } },
      post: { summary: 'Upload file (multipart) → /f/<fileId>', responses: { '200': { description: 'OK' } } },
    },
    '/v1/files/{id}': {
      get: { summary: 'Get file metadata', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      delete: { summary: 'Delete a file', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },
    '/v1/files/{id}/link': {
      post: { summary: 'Get a fresh download URL', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/v1/files/{id}/revoke': {
      post: { summary: 'Revoke the cached download URL', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },

    // ─── Share tokens ─────────────────────────────────────────────────────
    '/v1/share/{token}': {
      get: { summary: 'Public read of one scoped key', security: [], parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found / revoked' } } },
    },
    '/v1/write/{token}': {
      post: { summary: 'Public write (incr/set/append) to one scoped key', security: [], parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '403': { description: 'Mode not allowed' } } },
    },

    // ─── GraphQL ─────────────────────────────────────────────────────────
    '/api/v1/graphql': {
      post: {
        summary: 'GraphQL query endpoint (subset: records, collections, apiKeys, logs, me)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' }, variables: { type: 'object' } }, required: ['query'] } } } },
        responses: { '200': { description: 'Standard GraphQL JSON response { data, errors }' } },
      },
    },

    // ─── RPC ─────────────────────────────────────────────────────────────
    '/api/v1/rpc/{name}': {
      post: {
        summary: 'Invoke a built-in RPC function',
        description: 'Built-ins: count_records, sum, aggregate, search, touch.',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string', enum: ['count_records', 'sum', 'aggregate', 'search', 'touch'] } }],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'OK' }, '400': { description: 'Bad request' }, '404': { description: 'Unknown RPC' } },
      },
    },

    // ─── Views ───────────────────────────────────────────────────────────
    '/api/v1/views': {
      get: { summary: 'List views', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/View' } } } } } } },
      post: {
        summary: 'Create a view',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/View' } } } },
        responses: { '200': { description: 'OK' }, '409': { description: 'Already exists' } },
      },
    },
    '/api/v1/views/{name}': {
      get: { summary: 'Execute the view (run the projection)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      delete: { summary: 'Delete a view', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },

    // ─── Functions ───────────────────────────────────────────────────────
    '/api/v1/functions': {
      get: { summary: 'List functions', responses: { '200': { description: 'OK' } } },
      post: {
        summary: 'Create a server-side JS function',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Function' } } } },
        responses: { '200': { description: 'OK' }, '409': { description: 'Already exists' } },
      },
    },
    '/api/v1/functions/{name}': {
      get: { summary: 'Get a function', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      post: {
        summary: 'Test-invoke a function (manual trigger)',
        description: 'Runs the stored JS code in a `new Function(ctx, code)` sandbox with `{ record, db, user }`. The body becomes `ctx.record` (optional).',
        parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: false, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'OK' }, '500': { description: 'Runtime error' } },
      },
      delete: { summary: 'Delete a function', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },

    // ─── Materialized Views ──────────────────────────────────────────────
    '/api/v1/matviews': {
      get: { summary: 'List materialized views', responses: { '200': { description: 'OK' } } },
      post: {
        summary: 'Create a materialized view + compute the cached result',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/MaterializedView' } } } },
        responses: { '200': { description: 'OK' }, '409': { description: 'Already exists' } },
      },
    },
    '/api/v1/matviews/{name}': {
      get: { summary: 'Read the cached result (O(1))', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      post: { summary: 'Refresh (re-run the query + recache)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      delete: { summary: 'Delete a materialized view', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },

    // ─── Admin: network + branches ───────────────────────────────────────
    '/api/admin/network': {
      get: { summary: 'Get the current IP allowlist config (admin)', responses: { '200': { description: 'OK' }, '401': { description: 'Admin key required' } } },
      post: { summary: 'Mutate the runtime IP allowlist (admin)', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } }, responses: { '200': { description: 'OK' } } },
    },
    '/api/admin/branches': {
      get: { summary: 'List DB branch snapshots (admin)', responses: { '200': { description: 'OK' } } },
      post: {
        summary: 'Create or restore a DB branch snapshot (admin)',
        description: 'Body { name } creates a snapshot of the SQLite + JSON cache. Body { name, action: "restore" } restores it.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, action: { type: 'string', enum: ['create', 'restore'] } }, required: ['name'] } } } },
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/admin/branches/{name}': {
      delete: { summary: 'Remove a DB branch snapshot (admin)', parameters: [{ name: 'name', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
    },

    // ─── Email OTP / automated email service (MCPEmail) ──────────────────
    '/api/email-otp/send': {
      post: {
        summary: 'Send a 6-digit verification code to any email address',
        description:
          'Automated email service backed by your MCPEmail API key (mcpe_<64-hex>). Configure the key once via PUT /api/dashboard/mcpemail-config (dashboard → Email OTP tab). Rate-limited per target email (30s between sends, 10/hour). The code expires after 10 minutes and is stored durably with your account.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email', example: 'user@example.com' },
                  purpose: { type: 'string', example: 'login', description: 'Optional label persisted with the request.' },
                },
                required: ['email'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Code sent', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, expiresInSec: { type: 'integer', example: 600 }, retryAfterSec: { type: 'integer', example: 30 } } } } } },
          '400': { description: 'Missing/invalid email or no MCPEmail key configured (see PUT /api/dashboard/mcpemail-config)' },
          '429': { description: 'Rate limited — retry after retryAfterSec' },
          '502': { description: 'MCPEmail upstream error (invalid key, quota, provider outage)' },
        },
      },
    },
    '/api/email-otp/verify': {
      post: {
        summary: 'Verify a 6-digit code for an email address',
        description:
          'Checks the code against the latest non-expired, non-consumed code sent to that email. On success the code is consumed (single-use). Body may alternatively carry a requestId returned by /send for extra precision.',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  email: { type: 'string', format: 'email', example: 'user@example.com' },
                  code: { type: 'string', example: '482913', description: 'The 6-digit code from the email.' },
                  requestId: { type: 'string', description: 'Optional id returned by /send.' },
                },
                required: ['email', 'code'],
              },
            },
          },
        },
        responses: {
          '200': { description: 'Verified', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean', example: true }, verified: { type: 'boolean', example: true } } } } } },
          '400': { description: 'Wrong or malformed code' },
          '410': { description: 'Code expired (10 min TTL) or already used' },
          '404': { description: 'No code was ever sent to this email' },
        },
      },
    },
    '/api/dashboard/mcpemail-config': {
      get: { summary: 'Read the MCPEmail automation config (masked key)', responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, config: { type: 'object', properties: { hasConfig: { type: 'boolean' }, apiKeyMasked: { type: 'string', example: 'mcpe_4c7b1e9a…1f3a' }, label: { type: 'string', nullable: true }, fromName: { type: 'string', nullable: true }, subjectTemplate: { type: 'string', nullable: true }, bodyTemplate: { type: 'string', nullable: true } } } } } } } }, '401': { description: 'Bearer key required' } } },
      put: {
        summary: 'Save the MCPEmail API key + email templates (validates via live handshake)',
        description:
          'Body: { apiKey: "mcpe_<64-hex>", label?, fromName?, subjectTemplate?, bodyTemplate?, testConnection? }. The key is validated locally (prefix mcpe_, 25+ chars) and against the live mcpemails.com MCP endpoint (initialize handshake). The key is stored with your account and mirrored to Telegram — it survives cold boots.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { apiKey: { type: 'string', example: 'mcpe_4c7b1e9a0d5f…' }, label: { type: 'string' }, fromName: { type: 'string', example: 'Onyx Base' }, subjectTemplate: { type: 'string', example: 'Your verification code' }, bodyTemplate: { type: 'string', example: 'Your code is {{code}} — expires in 10 minutes.' }, testConnection: { type: 'boolean', example: true } }, required: ['apiKey'] } } } },
        responses: {
          '200': { description: 'Saved (connection tested if requested)', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, connection: { type: 'object', properties: { ok: { type: 'boolean' }, serverName: { type: 'string', example: 'mcpemails' }, protocolVersion: { type: 'string', example: '2025-06-18' } } } } } } } },
          '400': { description: 'bad_key — must start with mcpe_ and be at least 25 characters' },
          '502': { description: 'Handshake with mcpemails.com failed (invalid key or provider outage)' },
        },
      },
      delete: { summary: 'Remove the MCPEmail config', responses: { '200': { description: 'Removed' }, '401': { description: 'Bearer key required' } } },
    },

    // ─── Chunked file upload (any file size) ─────────────────────────────
    '/api/files/upload/init': {
      post: {
        summary: 'Chunked upload — mint the plan (files of ANY size)',
        description:
          'STATELESS protocol v2: the server keeps no session — the client echoes the plan fields on every subsequent call, so ANY instance can serve ANY step (multi-instance serverless safe). Small files (≤ 8 MB) can use the single-shot POST /api/files instead; larger files are split client-side into 4 MB chunks so every request stays under every platform body limit (Vercel ~4.5 MB, Next.js proxy cap). Size is validated against the storage backend ceiling (50 MB cloud Bot API / 2 GB local Bot API) at init time.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { fileName: { type: 'string' }, mimeType: { type: 'string', example: 'application/octet-stream' }, size: { type: 'integer', format: 'int64', example: 31457280 }, label: { type: 'string' }, isPublic: { type: 'boolean', example: true }, chunkSize: { type: 'integer', example: 4194304 } }, required: ['fileName', 'size'] } } } },
        responses: { '200': { description: 'Plan minted — uploadId + chunkSize/chunkCount (store these client-side and echo them on every call)', content: { 'application/json': { schema: { type: 'object', properties: { uploadId: { type: 'string', format: 'uuid' }, chunkSize: { type: 'integer', example: 4194304 }, chunkCount: { type: 'integer', example: 8 }, storageMode: { type: 'string', enum: ['server', 'custom'] }, maxUploadBytes: { type: 'integer' } } } } } }, '400': { description: 'Invalid size/fileName (max 2 GB)' }, '413': { description: 'File exceeds the storage backend ceiling (50 MB cloud / 2 GB local Bot API)' } },
      },
    },
    '/api/files/upload/chunk': {
      post: {
        summary: 'Upload one chunk (raw binary body) — staged as a Telegram document',
        description:
          'POST the RAW chunk bytes as the request body (Content-Type: application/octet-stream) with the plan echoed as query params. The server stages the chunk as a Telegram document (<uploadId>.part<NNNNNN>) in your resolved storage chat and returns { messageId, fileId } — the client collects one ref per chunk and hands the full set to /complete. A retried index stages a NEW document; keep the newest ref per index.',
        parameters: [
          { name: 'uploadId', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
          { name: 'index', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'chunkCount', in: 'query', required: true, schema: { type: 'integer' }, description: 'Echoed from init' },
          { name: 'chunkSize', in: 'query', required: true, schema: { type: 'integer' }, description: 'Echoed from init' },
          { name: 'size', in: 'query', required: true, schema: { type: 'integer', format: 'int64' }, description: 'Echoed from init' },
        ],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: { '200': { description: 'Chunk staged on Telegram', content: { 'application/json': { schema: { type: 'object', properties: { messageId: { type: 'integer' }, fileId: { type: 'string' }, storageMode: { type: 'string', enum: ['server', 'custom'] }, botApiBaseUrl: { type: 'string', nullable: true }, bytes: { type: 'integer' } } } } } }, '400': { description: 'Wrong chunk size / index out of range' }, '502': { description: 'Telegram rejected the upload' }, '503': { description: 'Storage not configured' } },
      },
    },
    '/api/files/upload/status': {
      post: {
        summary: 'Verify the staged chunk set (getFile metadata only)',
        description: 'POST the collected chunk refs; each is verified against Telegram via getFile (no bytes downloaded). Reports missing and size-mismatched indexes so the client knows exactly what to re-send.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { uploadId: { type: 'string', format: 'uuid' }, chunkCount: { type: 'integer' }, chunkSize: { type: 'integer' }, size: { type: 'integer', format: 'int64' }, chunks: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, fileId: { type: 'string' }, storageMode: { type: 'string' } } } } }, required: ['chunkCount', 'chunkSize', 'size', 'chunks'] } } } },
        responses: { '200': { description: 'Verification result', content: { 'application/json': { schema: { type: 'object', properties: { complete: { type: 'boolean' }, missing: { type: 'array', items: { type: 'integer' } }, mismatched: { type: 'array', items: { type: 'integer' } }, verified: { type: 'integer' } } } } } }, '405': { description: 'GET is not part of protocol v2 (no server-side session)' } },
      },
    },
    '/api/files/upload/complete': {
      post: {
        summary: 'Assemble + ship to Telegram + register the file',
        description: 'Send the plan + ALL collected chunk refs. ANY instance downloads the staged chunks (each size-verified via getFile first), assembles, verifies the total byte count, uploads to the storage backend via the same path as single-shot, registers the file record, deletes the staged part-messages, and returns the same shape as POST /api/files.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { uploadId: { type: 'string', format: 'uuid' }, fileName: { type: 'string' }, mimeType: { type: 'string' }, size: { type: 'integer', format: 'int64' }, chunkSize: { type: 'integer' }, chunkCount: { type: 'integer' }, label: { type: 'string', nullable: true }, isPublic: { type: 'boolean' }, chunks: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, messageId: { type: 'integer' }, fileId: { type: 'string' }, storageMode: { type: 'string' } } } } }, required: ['uploadId', 'fileName', 'size', 'chunkSize', 'chunkCount', 'chunks'] } } } },
        responses: { '200': { description: 'File stored', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, file: { $ref: '#/components/schemas/File' } } } } } }, '400': { description: 'Bad refs / corrupt assembly (sizes verified before download)' }, '413': { description: 'File exceeds the storage backend ceiling' } },
      },
    },
    '/api/files/upload/abort': {
      post: {
        summary: 'Discard an in-progress transfer (delete staged Telegram part-messages)',
        description: 'Best-effort deletion of every staged part-message the client collected — call when giving up so the storage chat stays clean.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { uploadId: { type: 'string', format: 'uuid' }, chunks: { type: 'array', items: { type: 'object', properties: { messageId: { type: 'integer' }, storageMode: { type: 'string' } } } } }, required: ['uploadId', 'chunks'] } } } },
        responses: { '200': { description: '{ deleted, attempted } (best-effort, idempotent)' } },
      },
    },
  },
}

export async function GET() {
  return NextResponse.json(SPEC, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
}

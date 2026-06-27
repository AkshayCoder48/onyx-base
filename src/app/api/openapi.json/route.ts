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

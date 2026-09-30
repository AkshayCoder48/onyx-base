import { withApiHandler } from '@/lib/with-api-handler'
import { authorize, type ApiKeyScope } from '@/lib/auth'
import { readJson } from '@/lib/v6'
import { getKeyWithRehydrate, setKey, deleteKey, listKeysWithRehydrate } from '@/lib/kv'

export const runtime = 'nodejs'

/**
 * POST /api/v6/batch — execute several KV operations in ONE round trip.
 *
 * Body: { ops: Array<Op> } where Op is one of:
 *   { op: 'get',    key, collection? }
 *   { op: 'set',    key, value, collection? }   // value = raw or typed JSON
 *   { op: 'delete', key, collection? }
 *   { op: 'list',   collection? }
 *
 * Response: { ok: true, data: { results: Array<per-op result> } } where each
 * result is `{ ok: true, …payload }` or `{ ok: false, error, code? }`.
 * One op failing never aborts the batch — every op is answered
 * individually so callers can act on partial success.
 *
 * Per-op authorization mirrors the v1 surface: get/list need `read`,
 * set needs `write`, delete needs `delete` (plus collection allow-lists and
 * byte quotas). This is the assistant's low-invocation transport: a
 * multi-step plan costs ONE function invocation instead of N.
 */
export const POST = withApiHandler({
  operation: 'v6.batch',
  requireAuth: true,
  handler: async (req, ctx) => {
    if (!ctx.user) return ctx.fail('Unauthorized.', 401)
    const user = ctx.user

    const body = await readJson(req)
    const ops = body?.ops
    if (!Array.isArray(ops) || ops.length === 0) {
      return ctx.fail('`ops` must be a non-empty array.', 400)
    }
    if (ops.length > 25) {
      return ctx.fail('Too many ops (max 25 per batch).', 400)
    }

    const results: Array<Record<string, unknown>> = []

    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as Record<string, unknown>
      const kind = typeof op?.op === 'string' ? op.op : ''
      const key = typeof op?.key === 'string' ? op.key : ''
      const collection = typeof op?.collection === 'string' && op.collection ? op.collection : 'default'

      try {
        // ── per-op shape validation + authorization ──────────────────────
        if (kind === 'get' || kind === 'list') {
          const z = authorize(user, req, { scope: 'read' as ApiKeyScope, collection })
          if (!z.ok) {
            results.push({ ok: false, error: z.message ?? 'forbidden', code: z.code })
            continue
          }
        } else if (kind === 'set') {
          if (!key.trim()) {
            results.push({ ok: false, error: '`key` is required for set.', code: 'bad_request' })
            continue
          }
          if (op.value === undefined) {
            results.push({ ok: false, error: '`value` is required for set.', code: 'bad_request' })
            continue
          }
          const z = authorize(user, req, {
            scope: 'write' as ApiKeyScope,
            collection,
            bytesWritten: JSON.stringify(op.value ?? null).length,
          })
          if (!z.ok) {
            results.push({ ok: false, error: z.message ?? 'forbidden', code: z.code })
            continue
          }
        } else if (kind === 'delete') {
          if (!key.trim()) {
            results.push({ ok: false, error: '`key` is required for delete.', code: 'bad_request' })
            continue
          }
          const z = authorize(user, req, { scope: 'delete' as ApiKeyScope, collection })
          if (!z.ok) {
            results.push({ ok: false, error: z.message ?? 'forbidden', code: z.code })
            continue
          }
        } else {
          results.push({ ok: false, error: `Unknown op "${kind}" (get|set|delete|list).`, code: 'bad_request' })
          continue
        }

        // ── execute ───────────────────────────────────────────────────────
        if (kind === 'get') {
          const rec = await getKeyWithRehydrate(user, key, collection)
          results.push({ ok: true, record: rec })
        } else if (kind === 'list') {
          const records = await listKeysWithRehydrate(user, collection === 'default' ? undefined : collection)
          results.push({ ok: true, records, count: records.length })
        } else if (kind === 'set') {
          const isPlainObject =
            op.value !== null && typeof op.value === 'object' && !Array.isArray(op.value)
          const record = await setKey(user, {
            key,
            collection,
            // Objects/arrays pass through typed; everything else as raw (the
            // same coercion the v1 dashboard POST applies).
            json: isPlainObject || Array.isArray(op.value) ? op.value : undefined,
            raw: isPlainObject || Array.isArray(op.value) ? undefined : String(op.value ?? ''),
            source: 'v6-batch',
          })
          results.push({ ok: true, record })
        } else if (kind === 'delete') {
          const res = await deleteKey(user, key, collection, 'v6-batch')
          results.push({ ok: true, ...res })
        }
      } catch (err) {
        results.push({
          ok: false,
          error: err instanceof Error ? err.message : 'op failed',
          code: 'op_error',
        })
      }
    }

    ctx.log({ op: 'v6.batch', count: ops.length, ok: results.filter((r) => r.ok).length })

    return ctx.ok({ results })
  },
})

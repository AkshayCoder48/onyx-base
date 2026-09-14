/**
 * Onyx Base — shared limit/offset pagination parsing for /v1/list and
 * /v1/export (PRD §20 / RGE Hub PRD §14).
 *
 * Contract (identical on both endpoints):
 *   - `?limit=N&offset=M` are BOTH optional.
 *   - When BOTH are absent the routes keep their legacy full-result behavior
 *     (backward compatible — existing consumers see zero change).
 *   - When EITHER is present the route paginates the sorted key list:
 *       limit  — integer, 1..1000 (defaults to 100 when only offset is given)
 *       offset — integer, >= 0 (defaults to 0 when only limit is given)
 *   - The response then carries a `__pagination` metadata field
 *     `{ total, limit, offset, hasMore }` next to the data.
 */

export interface PaginationParams {
  limit: number
  offset: number
}

export interface PaginationMeta {
  total: number
  limit: number
  offset: number
  hasMore: boolean
}

/** Default page size when a caller sends `?offset=` without `?limit=`. */
export const DEFAULT_PAGE_LIMIT = 100

/** Hard cap on `limit` (matches the /v1/tables row-listing ceiling). */
export const MAX_PAGE_LIMIT = 1000

/**
 * Parse `?limit=N&offset=M` from a request's query string.
 *
 * Returns `{ pagination: null, error: null }` when neither param is present
 * (legacy mode), `{ pagination, error: null }` when valid, or
 * `{ pagination: null, error }` when a provided value is malformed — the
 * caller should surface `error` as a 400.
 */
export function parsePagination(searchParams: URLSearchParams): {
  pagination: PaginationParams | null
  error: string | null
} {
  const limitRaw = searchParams.get('limit')
  const offsetRaw = searchParams.get('offset')
  if (limitRaw === null && offsetRaw === null) {
    return { pagination: null, error: null }
  }

  let limit = DEFAULT_PAGE_LIMIT
  if (limitRaw !== null) {
    const n = Number(limitRaw)
    if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) {
      return { pagination: null, error: `\`limit\` must be an integer between 1 and ${MAX_PAGE_LIMIT}.` }
    }
    limit = n
  }

  let offset = 0
  if (offsetRaw !== null) {
    const n = Number(offsetRaw)
    if (!Number.isInteger(n) || n < 0) {
      return { pagination: null, error: '`offset` must be an integer >= 0.' }
    }
    offset = n
  }

  return { pagination: { limit, offset }, error: null }
}

/**
 * Build the `__pagination` metadata block for a paginated response.
 * `returned` is the number of items actually included in this page.
 */
export function paginationMeta(total: number, p: PaginationParams, returned: number): PaginationMeta {
  return {
    total,
    limit: p.limit,
    offset: p.offset,
    hasMore: p.offset + returned < total,
  }
}

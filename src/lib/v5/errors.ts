/**
 * OnyxBase V5 — error contract (FROZEN, docs/v5-contract.md).
 *
 * V5 error responses are ALWAYS:
 *   { ok: false, error: <message>, code: <V5ErrorCode>, requestId, durationMs }
 * plus optional extra fields (e.g. `retryable: true`, blob `status`).
 *
 * There is deliberately NO generic "server busy" — every failure maps to one
 * of the contract codes below with an actionable message.
 */

export type V5ErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'AUTH_REQUIRED'
  | 'AUTH_INVALID_CREDENTIALS'
  | 'EMAIL_TAKEN'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_IN_FLIGHT'
  | 'PAYLOAD_TOO_LARGE'
  | 'BLOB_NOT_READY'
  | 'STORAGE_UNAVAILABLE'
  | 'DATABASE_UNAVAILABLE'
  | 'UNKNOWN_ERROR'

/** HTTP status for each contract error code. */
export const V5_CODE_STATUS: Record<V5ErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  AUTH_REQUIRED: 401,
  AUTH_INVALID_CREDENTIALS: 401,
  EMAIL_TAKEN: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_IN_FLIGHT: 409,
  PAYLOAD_TOO_LARGE: 413,
  BLOB_NOT_READY: 409,
  STORAGE_UNAVAILABLE: 503,
  DATABASE_UNAVAILABLE: 503,
  UNKNOWN_ERROR: 500,
}

/**
 * A V5-contract error. Thrown anywhere inside a V5 handler/lib; the
 * withV5Handler wrapper normalizes it to the contract response shape.
 */
export class V5Error extends Error {
  readonly code: V5ErrorCode
  readonly status: number
  /** Extra top-level fields merged into the error body (retryable, status…). */
  readonly extra: Record<string, unknown>

  /**
   * @param extra Either extra top-level fields merged into the error body
   *              (retryable, status…) OR a number — an HTTP status override.
   */
  constructor(code: V5ErrorCode, message: string, extra: Record<string, unknown> | number = {}) {
    super(message)
    this.name = 'V5Error'
    this.code = code
    this.status = typeof extra === 'number' ? extra : V5_CODE_STATUS[code] ?? 500
    this.extra = typeof extra === 'number' ? {} : extra
  }
}

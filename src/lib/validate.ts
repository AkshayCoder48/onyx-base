/**
 * Onyx Base — shared validation helpers (isomorphic, no server-only imports).
 *
 * Used by both the server (auth routes) and the client (login form) so the
 * validation rules stay perfectly in sync.
 */

/**
 * Strict email validation. Requires a real domain with a dot, a TLD of 2+
 * letters, and no consecutive dots. Rejects junk like "a@b", "test@test",
 * "a@b.c", "@@x.com".
 *
 * @example
 *   isValidEmail("ada@example.com")        // true
 *   isValidEmail("first.last+tag@sub.co.uk") // true
 *   isValidEmail("a@b")                      // false
 *   isValidEmail("test@test")                // false
 *   isValidEmail("a@b..com")                 // false
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/

export function isValidEmail(email: string): boolean {
  const trimmed = email.trim().toLowerCase()
  if (!trimmed || trimmed.length > 254) return false
  if (!EMAIL_RE.test(trimmed)) return false
  if (/\.\./.test(trimmed)) return false
  return true
}

/** Human-friendly explanation of why an email is invalid (empty string if valid). */
export function emailValidationError(email: string): string {
  const trimmed = email.trim()
  if (!trimmed) return 'Email is required.'
  if (trimmed.length > 254) return 'Email is too long.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return 'Enter a valid email like you@example.com.'
  }
  if (!isValidEmail(trimmed)) {
    return 'That email looks invalid. Use a real domain (e.g. you@example.com).'
  }
  if (/\.\./.test(trimmed)) {
    return 'Email cannot contain consecutive dots.'
  }
  return ''
}

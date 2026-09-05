/**
 * Canonical public base URL of this deployment.
 *
 * Priority:
 *   1. NEXT_PUBLIC_APP_URL env (operator override — set on Vercel)
 *   2. VERCEL_PROJECT_PRODUCTION_URL (Vercel injects this at build time)
 *   3. '' (relative — links resolve against the current origin)
 *
 * Safe for both server and client components: it reads build-time inlined
 * public vars only, never request headers.
 */
export function getBaseUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_APP_URL
  if (explicit && explicit.startsWith('http')) {
    // Trim a trailing slash so `${BASE}/v1/…` never produces `//`.
    return explicit.replace(/\/+$/, '')
  }
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL
  if (vercel) return `https://${vercel}`
  return ''
}

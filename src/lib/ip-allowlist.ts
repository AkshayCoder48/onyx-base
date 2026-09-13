/**
 * Onyx Base — IP allowlist (Network Restrictions).
 *
 * Optional defence-in-depth layer: when `IP_ALLOWLIST` is set in the env,
 * only requests from the listed IPs / CIDRs are allowed. When unset, every
 * IP is allowed (the platform is openly reachable by default, just like
 * Supabase's "all IPs allowed" out-of-the-box state).
 *
 * The allowlist can be set two ways:
 *   1. `IP_ALLOWLIST` env var (comma-separated IPs / CIDRs) — operator-level.
 *   2. Runtime override via `setRuntimeAllowlist()` (admin API mutations).
 *
 * Both lists are merged — a request is allowed if its IP matches EITHER list.
 *
 * CIDR matching: we handle IPv4 /32 (single IP) and proper CIDR prefixes
 * (e.g. 10.0.0.0/8, 192.168.1.0/24). IPv6 is supported at the "exact match"
 * level; full IPv6 CIDR maths is intentionally omitted (operators using IPv6
 * should pin single addresses or use a real firewall).
 */

import { NextRequest } from 'next/server'

// ─── Runtime override (mutated by /api/admin/network) ────────────────────────

const runtimeAllowlist: Set<string> = new Set()

/** Replace the entire runtime allowlist. Pass an empty array to clear it. */
export function setRuntimeAllowlist(entries: string[]): void {
  runtimeAllowlist.clear()
  for (const e of entries) {
    const trimmed = e.trim()
    if (trimmed) runtimeAllowlist.add(trimmed)
  }
}

/** Add a single entry to the runtime allowlist. */
export function addRuntimeEntry(entry: string): void {
  const trimmed = entry.trim()
  if (trimmed) runtimeAllowlist.add(trimmed)
}

/** Remove a single entry from the runtime allowlist. */
export function removeRuntimeEntry(entry: string): void {
  runtimeAllowlist.delete(entry.trim())
}

/** Snapshot the current runtime allowlist (sorted). */
export function getRuntimeAllowlist(): string[] {
  return Array.from(runtimeAllowlist).sort()
}

// ─── Env allowlist ───────────────────────────────────────────────────────────

/** The static env-configured allowlist (parsed once at module load). */
const ENV_ALLOWLIST: string[] = (() => {
  const raw = process.env.IP_ALLOWLIST
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
})()

/** Snapshot the env allowlist. */
export function getEnvAllowlist(): string[] {
  return [...ENV_ALLOWLIST]
}

/** True when neither env nor runtime allowlist has any entries. */
export function isAllowlistEnabled(): boolean {
  return ENV_ALLOWLIST.length > 0 || runtimeAllowlist.size > 0
}

// ─── IP extraction ───────────────────────────────────────────────────────────

/**
 * Resolve the client IP from a Next.js request. Behind the Caddy gateway,
 * `x-forwarded-for` is set by the proxy and contains the real client IP.
 * Falls back to `req.headers.get('x-real-ip')` then `req.nextUrl`'s host.
 */
export function getClientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    // X-Forwarded-For: client, proxy1, proxy2 — leftmost is the client.
    return xff.split(',')[0].trim()
  }
  const xri = req.headers.get('x-real-ip')
  if (xri) return xri.trim()
  return 'unknown'
}

// ─── CIDR matching ───────────────────────────────────────────────────────────

/**
 * Check whether an IPv4 address falls inside an IPv4 CIDR.
 * Returns false for IPv6 addresses or malformed inputs.
 */
function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, prefixStr] = cidr.split('/')
  const prefix = prefixStr === undefined ? 32 : parseInt(prefixStr, 10)
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false

  const ipInt = ipv4ToInt(ip)
  const rangeInt = ipv4ToInt(range)
  if (ipInt === null || rangeInt === null) return false

  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0
  return (ipInt & mask) === (rangeInt & mask)
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    const octet = parseInt(part, 10)
    if (Number.isNaN(octet) || octet < 0 || octet > 255) return null
    result = (result << 8) | octet
  }
  return result >>> 0
}

/**
 * True if the IP matches a single allowlist entry (IP literal or CIDR).
 * IPv6 only matches on exact string equality (no CIDR maths).
 */
function ipMatchesEntry(ip: string, entry: string): boolean {
  if (!entry.includes('/')) {
    // Single IP — exact match (case-insensitive for IPv6).
    return ip.toLowerCase() === entry.toLowerCase()
  }
  // CIDR — only IPv4 supported for prefix matching.
  if (ip.includes(':')) return false
  return ipv4InCidr(ip, entry)
}

/**
 * Determine whether a request IP is allowed.
 * - When the allowlist is empty (env + runtime), every IP is allowed.
 * - Otherwise the IP must match at least one entry.
 */
export function isIpAllowed(ip: string): boolean {
  if (!isAllowlistEnabled()) return true
  if (!ip || ip === 'unknown') return false
  for (const entry of ENV_ALLOWLIST) {
    if (ipMatchesEntry(ip, entry)) return true
  }
  for (const entry of runtimeAllowlist) {
    if (ipMatchesEntry(ip, entry)) return true
  }
  return false
}

/** Convenience: check the IP from a Next.js request directly. */
export function isRequestIpAllowed(req: NextRequest): boolean {
  return isIpAllowed(getClientIp(req))
}

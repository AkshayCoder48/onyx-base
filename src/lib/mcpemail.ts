/**
 * Onyx Base — MCPEmail client.
 *
 * MCPEmails (https://mcpemails.com) is a Streamable HTTP MCP server that
 * exposes a JSON-RPC 2.0 endpoint at https://mcpemails.com/api/mcp.
 * Authentication is a Bearer API key (`mcpe_<64-hex-chars>`) issued from
 * the MCPEmails dashboard, e.g.
 *   mcpe_4c7b1e9a0d5f38a2b6e04d17c9f2a58b3d6e0f1a2b4c6d8e0f2a4b6c8d0e1f3a
 *
 * This module is a thin server-side wrapper that:
 *   1. Performs the `initialize` handshake so we know the key is valid.
 *   2. Calls `inbox_list` for the dashboard "Test connection" button.
 *   3. Calls `email_compose` with action `send` to deliver automation emails.
 *
 * The client is intentionally minimal — only the methods Onyx Base needs.
 * It does NOT implement the full MCP tool catalogue.
 *
 * Design notes:
 *   - Every call is a single POST with a JSON-RPC envelope; MCP does not
 *     require session cookies or persistent connections.
 *   - We set a strict 15s timeout on every call so a hung MCPEmails server
 *     can't stall the OTP send endpoint indefinitely.
 *   - We never log the bearer key. Errors carry the HTTP status + a short
 *     reason phrase only.
 */

const MCPEMAIL_ENDPOINT = 'https://mcpemails.com/api/mcp'
const TIMEOUT_MS = 15_000

export interface McpeInbox {
  inbox_id: string
  email: string
  provider: string
  display_name?: string
  service?: string
}

export interface McpeSendResult {
  ok: boolean
  messageId?: string
  /** MCPEmails server notes about how the call was handled, when present. */
  notes?: string[]
  raw?: unknown
}

export class McpeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message)
    this.name = 'McpeError'
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0'
  id: number
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Shape of an MCP `tools/call` result as MCPEmails returns it.
 *
 * CRITICAL: a tool can FAIL while the HTTP response is 200 and the JSON-RPC
 * envelope has no `error` — the failure is signalled by `result.isError: true`
 * with a human-readable explanation in `result.content[].text` (and a
 * machine-readable code under `result._meta["<ns>/<code>"]`). This is how
 * MCPEmails reports rejected arguments (`additionalProperties: false`) and
 * account-level problems such as "no mailbox connected". Treating those as
 * success is how the original Email Automation bug silently dropped every
 * send while reporting `status: sent`.
 */
interface ToolCallResult {
  isError?: boolean
  content?: Array<{ type: string; text: string }>
  structuredContent?: Record<string, unknown>
  messageId?: string
  id?: string
  notes?: string[]
  [key: string]: unknown
}

/**
 * Make a single JSON-RPC 2.0 call to the MCPEmails endpoint.
 * Throws McpeError on any non-2xx HTTP response or JSON-RPC error.
 */
async function rpc<T = unknown>(
  apiKey: string,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(MCPEMAIL_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'onyx-base', version: '1.0' },
          capabilities: {},
          ...params,
        },
      }),
    })
    clearTimeout(timer)

    if (!res.ok) {
      // 401 / 403 from MCPEmails usually means an invalid or revoked API key.
      // 429 is the rate limit (100/min, 1000/hr, 10000/day per key).
      const text = await res.text().catch(() => '')
      throw new McpeError(
        `MCPEmails returned HTTP ${res.status}${text ? `: ${truncate(text, 200)}` : ''}`,
        res.status,
        res.status === 401 || res.status === 403 ? 'auth_failed' : 'http_error',
      )
    }

    const data = (await res.json()) as JsonRpcResponse<T> & { result?: T }
    if (data.error) {
      throw new McpeError(
        `MCPEmails RPC error (${data.error.code}): ${data.error.message}`,
        200,
        'rpc_error',
      )
    }
    if (!data.result) {
      throw new McpeError('MCPEmails returned an empty result.', 200, 'empty_result')
    }
    // MCP tool-level failure: HTTP 200 + JSON-RPC result.isError === true.
    // This is a REAL failure — the tool refused to run (invalid arguments,
    // no mailbox connected, provider error…). Surface it, never swallow it.
    const result = data.result as unknown as ToolCallResult
    if (result && result.isError === true) {
      throw new McpeError(
        `MCPEmails tool error: ${toolErrorText(result)}`,
        200,
        'tool_error',
      )
    }
    return data.result
  } catch (err) {
    clearTimeout(timer)
    if (err instanceof McpeError) throw err
    if (err instanceof Error && err.name === 'AbortError') {
      throw new McpeError('MCPEmails request timed out (15s).', 408, 'timeout')
    }
    throw new McpeError(
      `Network error reaching MCPEmails: ${err instanceof Error ? err.message : String(err)}`,
      0,
      'network_error',
    )
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}

/** Extract the human-readable explanation from a tool-level isError result. */
function toolErrorText(result: ToolCallResult): string {
  const parts: string[] = []
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
  }
  // Machine-readable code, e.g. _meta: { 'com.mcpemails/invalid_arguments':
  // { error_code: 'invalid_arguments', retryable: false } }.
  const meta = result._meta
  if (meta && typeof meta === 'object') {
    for (const v of Object.values(meta as Record<string, unknown>)) {
      if (v && typeof v === 'object' && typeof (v as { error_code?: unknown }).error_code === 'string') {
        parts.push(`[code: ${(v as { error_code: string }).error_code}]`)
      }
    }
  }
  return truncate(parts.join(' '), 400) || 'unknown tool error (isError: true)'
}

/** Find a message id in any of the shapes MCPEmails uses (top-level,
 * structuredContent, or JSON inside a content text block). */
function findMessageId(result: ToolCallResult): string | undefined {
  const candidates: unknown[] = [
    result.messageId,
    result.id,
    result.structuredContent?.message_id,
    result.structuredContent?.messageId,
    result.structuredContent?.id,
  ]
  const sc = result.structuredContent
  if (sc && Array.isArray(sc.message_ids) && sc.message_ids.length > 0) {
    candidates.push(sc.message_ids[0])
  }
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text) as Record<string, unknown>
          candidates.push(parsed.messageId, parsed.id, parsed.message_id)
          if (Array.isArray(parsed.message_ids) && parsed.message_ids.length > 0) {
            candidates.push(parsed.message_ids[0])
          }
        } catch {
          /* plain text — no id inside */
        }
      }
    }
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c) return c
  }
  return undefined
}

/** Collect MCPEmails server notes ("argument not applied", etc.). */
function findNotes(result: ToolCallResult): string[] | undefined {
  const notes: string[] = []
  if (Array.isArray(result.notes)) {
    for (const n of result.notes) if (typeof n === 'string' && n.trim()) notes.push(n)
  }
  const sc = result.structuredContent
  if (sc && Array.isArray(sc.notes)) {
    for (const n of sc.notes) if (typeof n === 'string' && n.trim()) notes.push(n)
  }
  return notes.length > 0 ? notes : undefined
}

/**
 * Perform the `initialize` handshake. Used by the dashboard "Test connection"
 * button to verify the API key is valid without sending any email.
 *
 * Returns the server's protocol version + name. Throws McpeError on failure.
 */
export async function initializeMcpEmail(apiKey: string): Promise<{
  protocolVersion: string
  serverName: string
  serverVersion: string
}> {
  const result = await rpc<{
    protocolVersion?: string
    serverInfo?: { name?: string; version?: string }
  }>(apiKey, 'initialize', {})
  return {
    protocolVersion: result.protocolVersion ?? 'unknown',
    serverName: result.serverInfo?.name ?? 'mcpemails',
    serverVersion: result.serverInfo?.version ?? 'unknown',
  }
}

/**
 * List inboxes the API key can access. Used by the dashboard to show the user
 * which inbox their OTP emails will be sent FROM (the first inbox is the
 * default sender).
 *
 * Throws McpeError on failure (including auth errors).
 */
export async function listInboxes(apiKey: string): Promise<McpeInbox[]> {
  const result = await rpc<ToolCallResult>(apiKey, 'tools/call', {
    name: 'inbox_list',
    arguments: { include_capabilities: false },
  })

  // MCPEmails may return inboxes in structuredContent, directly, or wrapped
  // in a content text block.
  const sc = result.structuredContent
  if (sc && Array.isArray(sc.inboxes)) return sc.inboxes as McpeInbox[]
  if (Array.isArray(result.inboxes)) return result.inboxes as McpeInbox[]
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text)
          if (Array.isArray(parsed)) return parsed
          if (parsed && Array.isArray(parsed.inboxes)) return parsed.inboxes
        } catch {
          /* fall through */
        }
      }
    }
  }
  return []
}

/**
 * Send an email via the MCPEmails `email_compose` tool (action: 'send').
 *
 * - `to` is one recipient address or an array of addresses.
 * - `subject` and `body` make up the email contents; `htmlBody` is optional.
 * - When only an HTML body is supplied, `body` is OMITTED (the MCPEmails
 *   schema requires minLength:1 when present).
 *
 * IMPORTANT — argument hygiene (the bug that silently broke every send):
 *   MCPEmails validates `email_compose` arguments with
 *   `additionalProperties: false`. Any unknown argument — e.g. a display
 *   name (`from_name`) — is REJECTED with an HTTP 200 response whose result
 *   carries `isError: true`. The sender display name shown to recipients is
 *   controlled by the inbox's sender identity on mcpemails.com, NOT by a
 *   per-call argument. Never add an argument that is not in the published
 *   input schema.
 *
 * Returns `{ ok: true, messageId, notes }` on success. Throws McpeError on
 * failure — INCLUDING tool-level failures (isError: true) detected in rpc().
 *
 * NOTE: when the API key has exactly ONE inbox, MCPEmails auto-resolves the
 * sender — no inbox_id is needed. Multi-inbox keys would require the user to
 * specify which inbox; MCPEmails' default (first inbox) applies.
 *
 * PRIVACY: the `apiKey` argument is the USER'S OWN mcpe_* credential resolved
 * by the Email Automation orchestrator. The platform API key (kv_live_*) is
 * NEVER passed into this module.
 */
export async function sendEmailViaMcpe(
  apiKey: string,
  opts: {
    to: string | string[]
    subject: string
    body: string
    htmlBody?: string
    /**
     * DEPRECATED no-op kept for API compatibility: MCPEmails has no
     * per-send display-name argument and rejects unknown arguments.
     * The display name comes from the inbox's sender identity.
     */
    fromName?: string
  },
): Promise<McpeSendResult> {
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to])
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
  const args: Record<string, unknown> = {
    action: 'send',
    to: recipients,
    subject: opts.subject,
  }
  // Only include body when non-empty: the MCPEmails schema declares
  // body.minLength = 1, so an empty string is an invalid argument.
  if (opts.body) args.body = opts.body
  if (opts.htmlBody) args.html_body = opts.htmlBody

  const result = await rpc<ToolCallResult>(apiKey, 'tools/call', {
    name: 'email_compose',
    arguments: args,
  })

  return { ok: true, messageId: findMessageId(result), notes: findNotes(result), raw: result }
}

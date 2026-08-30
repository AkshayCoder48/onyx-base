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
 *   3. Calls `email_compose` with action `send` to deliver OTP emails.
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

    const data = (await res.json()) as JsonRpcResponse<T>
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
  const result = await rpc<{
    inboxes?: McpeInbox[]
    content?: Array<{ type: string; text: string }>
  }>(apiKey, 'tools/call', {
    name: 'inbox_list',
    arguments: { include_capabilities: false },
  })

  // MCPEmails may return inboxes directly, or wrap them in a content block.
  if (Array.isArray(result.inboxes)) return result.inboxes
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
 * Send an OTP email via the MCPEmails `email_compose` tool (action: 'send').
 *
 * - `fromName` is optional — MCPEmails uses the inbox's display name by default.
 * - `to` is the recipient's email address.
 * - `subject` and `body` make up the email contents.
 *
 * Returns `{ ok: true, messageId }` on success. Throws McpeError on failure.
 *
 * NOTE: when the API key has exactly ONE inbox, MCPEmails auto-resolves the
 * sender — no inbox_id is needed. Multi-inbox keys would require the user to
 * specify which inbox; for the OTP use-case we expect users to have a single
 * dedicated inbox. If they have multiple, the call will succeed and use the
 * first one (MCPEmails' default behavior).
 */
export async function sendEmailViaMcpe(
  apiKey: string,
  opts: {
    to: string
    subject: string
    body: string
    htmlBody?: string
  },
): Promise<McpeSendResult> {
  const args: Record<string, unknown> = {
    action: 'send',
    to: [opts.to],
    subject: opts.subject,
    body: opts.body,
  }
  if (opts.htmlBody) args.html_body = opts.htmlBody

  const result = await rpc<{
    messageId?: string
    id?: string
    content?: Array<{ type: string; text: string }>
  }>(apiKey, 'tools/call', {
    name: 'email_compose',
    arguments: args,
  })

  // MCPEmails may return the messageId directly, or wrap it in a content block.
  let messageId: string | undefined = result.messageId ?? result.id
  if (!messageId && Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        try {
          const parsed = JSON.parse(block.text)
          if (parsed && typeof parsed.messageId === 'string') {
            messageId = parsed.messageId
            break
          }
          if (parsed && typeof parsed.id === 'string') {
            messageId = parsed.id
            break
          }
        } catch {
          /* fall through */
        }
      }
    }
  }

  return { ok: true, messageId, raw: result }
}

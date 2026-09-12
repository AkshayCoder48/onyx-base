/**
 * Probe the MCPEmails MCP endpoint: initialize handshake + tools/list + a
 * tools/call echo, so we can see the REAL schema of the `email_compose` tool.
 *
 * Usage: MCPE_KEY=<key> node scripts/probe-mcpemail.mjs [call <toolName> <jsonArgs>]
 * The key is ONLY read from the environment — never written to any file.
 */
const ENDPOINT = 'https://mcpemails.com/api/mcp'
const key = process.env.MCPE_KEY
if (!key) {
  console.error('MCPE_KEY env var required')
  process.exit(1)
}

async function rpc(method, params, label) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream, */*',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          protocolVersion: '2025-06-18',
          clientInfo: { name: 'onyx-probe', version: '1.0' },
          capabilities: {},
          ...params,
        },
      }),
    })
    clearTimeout(timer)
    const text = await res.text()
    console.log(`=== ${label} → HTTP ${res.status} (len ${text.length}) ===`)
    console.log(text.slice(0, 6000))
    console.log()
    if (process.env.PROBE_OUT) {
      const fs = await import('node:fs')
      fs.writeFileSync(process.env.PROBE_OUT, text)
      console.log(`(full response saved to ${process.env.PROBE_OUT})`)
    }
    try {
      return JSON.parse(text)
    } catch {
      return { raw: text }
    }
  } catch (err) {
    clearTimeout(timer)
    console.error(`=== ${label} FAILED: ${err.message} ===`)
    return null
  }
}

const mode = process.argv[2] || 'list'

if (mode === 'list') {
  await rpc('tools/list', {}, 'tools/list')
} else if (mode === 'call') {
  const tool = process.argv[3]
  const args = JSON.parse(process.argv[4] || '{}')
  await rpc('tools/call', { name: tool, arguments: args }, `tools/call ${tool}`)
} else if (mode === 'init') {
  await rpc('initialize', {}, 'initialize')
}

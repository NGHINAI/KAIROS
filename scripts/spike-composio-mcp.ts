// scripts/spike-composio-mcp.ts
//
// One-shot verification spike for Phase C.2.7. Confirms:
//   1. COMPOSIO_API_KEY auth works
//   2. composio.create(userId, config) returns a session with mcp.url + mcp.headers
//   3. session.mcp.url + headers can be connected with StreamableHTTPClientTransport
//      (if that fails, also tries SSEClientTransport)
//
// Run with:
//   COMPOSIO_API_KEY=ak_xxx bun run scripts/spike-composio-mcp.ts
//
// Output decides the HttpMcpClient transport choice in Task 4 of the C.2.7 plan.

import { Composio } from '@composio/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const apiKey = process.env.COMPOSIO_API_KEY
if (!apiKey) {
  console.error('COMPOSIO_API_KEY env var is required')
  process.exit(1)
}

function header(stage: string) {
  console.log('\n' + '='.repeat(60))
  console.log(stage)
  console.log('='.repeat(60))
}

header('[1/4] Initializing Composio client')
const composio = new Composio({ apiKey })
console.log('  ✓ Client constructed')

header('[2/4] Verifying auth — listing toolkits')
try {
  const toolkits = await composio.toolkits.get({ limit: 5 })
  const items = (toolkits as any).items ?? toolkits ?? []
  console.log(`  ✓ Auth works. Got ${items.length} toolkits in this page.`)
  console.log(`  Sample slugs:`, items.slice(0, 5).map((t: any) => t.slug ?? t.id ?? '?'))
} catch (err) {
  console.error('  ✗ Auth failed:', err instanceof Error ? err.message : err)
  console.error('  Full error:', err)
  process.exit(1)
}

header('[3/4] Creating ToolRouter session')
let session: any
try {
  // Minimal config. If toolkits: [] errors, try a known no-auth toolkit.
  session = await composio.create('spike-user', {
    manageConnections: true,
    // Test the documented workbench opt-out — if this removes COMPOSIO_REMOTE_BASH_TOOL,
    // amendment #3 from the plan is validated against real behavior.
    workbench: { enable: false },
  } as any)
  console.log(`  ✓ Session created`)
  console.log(`  session_id: ${(session as any).id ?? (session as any).session_id ?? '<unknown>'}`)
  const mcpInfo = (session as any).mcp ?? (session as any).mcpServer ?? null
  if (mcpInfo) {
    console.log(`  MCP URL: ${mcpInfo.url}`)
    console.log(`  MCP header keys:`, Object.keys(mcpInfo.headers ?? {}))
  } else {
    console.log('  ⚠ session.mcp not present. Full session keys:', Object.keys(session))
    console.log('  Session JSON preview:', JSON.stringify(session, null, 2).slice(0, 800))
  }
} catch (err) {
  console.error('  ✗ Session create failed:', err instanceof Error ? err.message : err)
  console.error('  Full error:', err)
  process.exit(1)
}

const mcpUrl: string | undefined = (session as any).mcp?.url
const mcpHeaders: Record<string, string> = (session as any).mcp?.headers ?? {}

if (!mcpUrl) {
  console.error('\n✗ No MCP URL on session — cannot test transport. Inspect the JSON above.')
  process.exit(1)
}

header('[4/4] Testing MCP transport')

async function tryStreamableHttp() {
  const client = new Client({ name: 'kairos-spike', version: '0.0.1' }, { capabilities: {} })
  try {
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl!), {
      requestInit: { headers: mcpHeaders },
    })
    await client.connect(transport)
    const result = await client.listTools()
    await client.close()
    return { ok: true, toolCount: (result.tools ?? []).length, sample: (result.tools ?? []).slice(0, 3).map(t => t.name) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

async function trySse() {
  const client = new Client({ name: 'kairos-spike', version: '0.0.1' }, { capabilities: {} })
  try {
    const transport = new SSEClientTransport(new URL(mcpUrl!), {
      requestInit: { headers: mcpHeaders },
      eventSourceInit: {
        fetch: (url: string | URL, init?: RequestInit) =>
          fetch(url, { ...init, headers: { ...(init?.headers ?? {}), ...mcpHeaders } }),
      } as any,
    })
    await client.connect(transport)
    const result = await client.listTools()
    await client.close()
    return { ok: true, toolCount: (result.tools ?? []).length, sample: (result.tools ?? []).slice(0, 3).map(t => t.name) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

console.log('  Trying StreamableHTTPClientTransport...')
const sh = await tryStreamableHttp()
if (sh.ok) {
  console.log(`  ✓ Streamable HTTP works. ${sh.toolCount} tools registered.`)
  console.log(`  Sample tool names:`, sh.sample)
  console.log('\n=== VERDICT ===')
  console.log('Use StreamableHTTPClientTransport in HttpMcpClient (Task 4 of C.2.7).')
  process.exit(0)
}

console.log(`  ✗ Streamable HTTP failed: ${sh.error}`)
console.log('  Trying SSEClientTransport...')
const sse = await trySse()
if (sse.ok) {
  console.log(`  ✓ SSE works. ${sse.toolCount} tools registered.`)
  console.log(`  Sample tool names:`, sse.sample)
  console.log('\n=== VERDICT ===')
  console.log('Use SSEClientTransport in HttpMcpClient (Task 4 of C.2.7).')
  process.exit(0)
}

console.log(`  ✗ SSE also failed: ${sse.error}`)
console.log('\n=== VERDICT ===')
console.log('Both transports failed. Investigate the URL/headers manually.')
process.exit(1)

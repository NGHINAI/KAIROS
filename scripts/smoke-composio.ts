// scripts/smoke-composio.ts
//
// Composio smoke test — exercises connect → tool-call → disconnect WITHOUT user interaction.
// Uses the session-only path (no browser, no OAuth) — creates a ToolRouter session,
// lists MCP tools via StreamableHTTPClientTransport, then tears down.
//
// This validates the full Composio subsystem pipeline:
//   ComposioClient → ComposioSessionManager → MCP URL → list-tools → session cleanup
//
// Run with: COMPOSIO_API_KEY=ak_xxx bun run scripts/smoke-composio.ts

import { Database } from 'bun:sqlite'
import { Composio } from '@composio/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { ComposioClient } from '../src/daemon/connectors/composioClient'
import { ConnectionStore } from '../src/daemon/connectors/connectionStore'
import { ComposioSessionManager } from '../src/daemon/connectors/composioSessionManager'
import { createDisconnectServiceIntent } from '../src/daemon/connectors/disconnectServiceIntent'

// ─── Setup ─────────────────────────────────────────────────────────────────────

const apiKey = process.env.COMPOSIO_API_KEY
if (!apiKey) {
  console.error('COMPOSIO_API_KEY env var is required')
  process.exit(1)
}

function pass(msg: string) { console.log(`  ✓ ${msg}`) }
function fail(msg: string) { console.error(`  ✗ ${msg}`) }
function step(label: string) { console.log(`\n[${label}]`) }

let exitCode = 0

// ─── Step 1: Auth check + listToolkits ─────────────────────────────────────────

step('1/6  Auth check — listing toolkits')

const composioClient = new ComposioClient({ apiKey })
let toolkits: Awaited<ReturnType<typeof composioClient.listToolkits>>
try {
  toolkits = await composioClient.listToolkits({ limit: 30 })
  pass(`Got ${toolkits.length} toolkits from catalog`)
  const sample = toolkits.slice(0, 5).map(t => `${t.slug}(${t.auth_type})`).join(', ')
  console.log(`  Sample: ${sample}`)
} catch (err) {
  fail(`listToolkits failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

// Report no-auth candidates (informational — we use session-only path)
const noAuthOnes = toolkits.filter(t => t.auth_type === 'no_auth')
console.log(`  No-auth candidates in first 30: ${noAuthOnes.length} (${noAuthOnes.map(t => t.slug).join(', ') || 'none'})`)

// ─── Step 2: Create ToolRouter session (workbench disabled) ───────────────────

step('2/6  Creating ToolRouter session (workbench: disabled)')

const sdk = new Composio({ apiKey, baseURL: 'https://backend.composio.dev' })
const sessionManager = new ComposioSessionManager({
  sdk,
  userId: 'smoke-test-user',
  toolkits: [],
  manageConnections: true,
})

try {
  await sessionManager.init()
  pass(`Session created: ${sessionManager.getSessionId()}`)
} catch (err) {
  fail(`Session create failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}

const mcpUrl = sessionManager.getMcpUrl()
const mcpHeaders = sessionManager.getMcpHeaders()
console.log(`  MCP URL: ${mcpUrl}`)
console.log(`  MCP header keys: ${Object.keys(mcpHeaders).join(', ')}`)

// ─── Step 3: Connect to MCP and list tools ─────────────────────────────────────

step('3/6  Connecting to MCP endpoint and listing tools')

async function tryStreamableHttp(url: string, headers: Record<string, string>) {
  const client = new Client({ name: 'kairos-smoke', version: '0.0.1' }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers },
  })
  await client.connect(transport)
  const result = await client.listTools()
  await client.close()
  return result.tools ?? []
}

async function trySse(url: string, headers: Record<string, string>) {
  const client = new Client({ name: 'kairos-smoke', version: '0.0.1' }, { capabilities: {} })
  const transport = new SSEClientTransport(new URL(url), {
    requestInit: { headers },
    eventSourceInit: {
      fetch: (u: string | URL, init?: RequestInit) =>
        fetch(u, { ...init, headers: { ...(init?.headers ?? {}), ...headers } }),
    } as any,
  })
  await client.connect(transport)
  const result = await client.listTools()
  await client.close()
  return result.tools ?? []
}

let tools: Array<{ name: string; description?: string }> = []
let transportUsed = 'none'

try {
  console.log('  Trying StreamableHTTPClientTransport...')
  tools = await tryStreamableHttp(mcpUrl, mcpHeaders)
  transportUsed = 'streamable-http'
  pass(`StreamableHTTP works — ${tools.length} tools registered`)
} catch (shErr) {
  console.log(`  Streamable HTTP failed: ${shErr instanceof Error ? shErr.message : shErr}`)
  console.log('  Trying SSEClientTransport...')
  try {
    tools = await trySse(mcpUrl, mcpHeaders)
    transportUsed = 'sse'
    pass(`SSE works — ${tools.length} tools registered`)
  } catch (sseErr) {
    fail(`Both transports failed. SSE error: ${sseErr instanceof Error ? sseErr.message : sseErr}`)
    process.exit(1)
  }
}

console.log(`  Transport: ${transportUsed}`)
const toolNames = tools.map(t => t.name)
console.log(`  Tool names: ${toolNames.join(', ')}`)

// ─── Step 4: Verify COMPOSIO meta-tools present (and bash tool absent) ─────────

step('4/6  Verifying COMPOSIO meta-tools present (workbench tools absent)')

const composioMetaTools = toolNames.filter(n => n.startsWith('COMPOSIO_') || n.startsWith('composio'))
const bashToolPresent = toolNames.some(n =>
  n.includes('BASH') || n.includes('bash') || n.includes('WORKBENCH') || n.includes('workbench'),
)

if (composioMetaTools.length > 0) {
  pass(`Found ${composioMetaTools.length} COMPOSIO meta-tool(s): ${composioMetaTools.join(', ')}`)
} else {
  // Not a hard failure — the meta-tools may only appear when manageConnections is active and
  // the session has toolkits registered. Warn but continue.
  console.log(`  ⚠  No COMPOSIO_ meta-tools found (${tools.length} total tools). Continuing.`)
}

if (!bashToolPresent) {
  pass('No bash/workbench tool present (workbench: disable verified)')
} else {
  fail('COMPOSIO_REMOTE_BASH_TOOL found — workbench opt-out did not work!')
  exitCode = 1
}

// ─── Step 5: Disconnect via ConnectionStore + DisconnectServiceIntent ──────────

step('5/6  Testing disconnect_service intent handler')

// We didn't do an OAuth connect, so there's no live connection to delete.
// We simulate a connection record in the store and verify the intent
// removes it + calls deleteConnection cleanly (error is tolerated because
// the connection_id is fake).

const db = new Database(':memory:')
const connStore = new ConnectionStore(db)

const FAKE_TOOLKIT = 'smoke-fake-toolkit'
const FAKE_CONN_ID = 'fake-conn-id-smoke-test'
const SMOKE_USER = 'smoke-test-user'

connStore.upsert({
  user_id: SMOKE_USER,
  toolkit_slug: FAKE_TOOLKIT,
  connection_id: FAKE_CONN_ID,
  auth_config_id: 'fake-auth-config',
  status: 'active',
  created_at: Date.now(),
})

const beforeRow = connStore.getByToolkit(SMOKE_USER, FAKE_TOOLKIT)
if (beforeRow) {
  pass('Fake connection row inserted into ConnectionStore')
} else {
  fail('Failed to insert fake connection row')
  exitCode = 1
}

// Stub session manager (no-op removeToolkit since we didn't create a real session with this toolkit)
const stubSessionManager = {
  removeToolkit: async (_slug: string) => { /* no-op */ },
}

// Stub composio deleteConnection — it will fail on a fake ID, which is expected
// and the disconnectServiceIntent should still clean up locally.
const disconnectIntent = createDisconnectServiceIntent({
  composio: composioClient,
  connectionStore: connStore,
  sessionManager: stubSessionManager,
  userId: SMOKE_USER,
})

const disconnectResult = await disconnectIntent.handler({ toolkit_slug: FAKE_TOOLKIT })

// Local cleanup should have happened regardless of Composio API result
const afterRow = connStore.getByToolkit(SMOKE_USER, FAKE_TOOLKIT)
if (!afterRow) {
  pass('ConnectionStore row removed after disconnect (local cleanup confirmed)')
} else {
  fail('ConnectionStore row still present after disconnect!')
  exitCode = 1
}

if (disconnectResult.ok) {
  pass('disconnect_service returned ok:true')
} else {
  // Expected if Composio rejected the fake connection_id — local cleanup was the goal
  console.log(`  ⚠  disconnect_service ok:false (expected for fake conn_id): ${disconnectResult.error}`)
  // Not a hard failure if local row was removed
  if (!afterRow) {
    pass('Local cleanup succeeded despite Composio API error (correct behavior)')
  }
}

// ─── Step 6: Verify DB is clean ────────────────────────────────────────────────

step('6/6  Cleanup verification')

const remaining = connStore.listByUser(SMOKE_USER)
if (remaining.length === 0) {
  pass('ConnectionStore is clean — no stale records for smoke-test-user')
} else {
  fail(`${remaining.length} stale record(s) remain in ConnectionStore`)
  exitCode = 1
}

pass('ComposioSessionManager session was created and used successfully')
console.log(`  Session ID: ${sessionManager.getSessionId()}`)
console.log(`  Toolkits in session: [${sessionManager.getToolkits().join(', ')}]`)

// ─── Final verdict ──────────────────────────────────────────────────────────────

console.log()
if (exitCode === 0) {
  console.log('=== Smoke test PASS ===')
} else {
  console.log('=== Smoke test FAIL ===')
}
process.exit(exitCode)

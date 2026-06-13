#!/usr/bin/env bun
// mcpStdioBridge.ts — a thin STDIO↔HTTP MCP bridge that codex spawns.
//
// WHY: codex 0.133's rmcp streamable-HTTP client is flaky against our in-process
// HTTP /mcp server — its standalone-stream handshake intermittently fails ("fail
// to get common stream"), and tools then aren't exposed to the model (verified
// 2026-06-13: tools/list returns 28, but the model can't call them). codex's
// STDIO MCP path is the proven one (openclicky/HeyClicky drive stdio servers).
//
// So: codex ⇄ (stdio, reliable) ⇄ THIS BRIDGE ⇄ (HTTP loopback, SDK client —
// proven to work) ⇄ daemon /mcp (the real toolset over buildActionToolset).
// The bridge is a dumb transparent proxy; the daemon still owns all tool state.
// codex spawns it via [mcp_servers.kairos] command="bun" args=[".../mcpStdioBridge.ts"].

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"

const MCP_URL = process.env.KAIROS_MCP_URL || "http://127.0.0.1:9876/mcp"
const MCP_TOKEN = process.env.KAIROS_MCP_TOKEN || ""

import { appendFileSync } from "node:fs"
const LOG = process.env.KAIROS_BRIDGE_LOG
function blog(m: string) { if (LOG) try { appendFileSync(LOG, `[bridge] ${m}\n`) } catch { /* */ } }

// LAZY upstream connect: connecting to the daemon must NOT block codex's stdio
// handshake — otherwise a slow/blocked upstream hangs codex at startup forever
// (the 2026-06-13 hang). We serve stdio immediately and connect to the daemon on
// first use, caching the connection.
let clientPromise: Promise<Client> | null = null
function daemonClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      blog(`connecting to ${MCP_URL}`)
      const t = new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } } })
      const c = new Client({ name: "kairos-stdio-bridge", version: "0.1.0" }, { capabilities: {} })
      await c.connect(t)
      blog("connected to daemon")
      return c
    })().catch((e) => { clientPromise = null; blog(`connect failed: ${String((e as Error)?.message ?? e)}`); throw e })
  }
  return clientPromise
}

async function main() {
  // ── server ← codex (stdio) FIRST — answer initialize immediately ──
  const server = new Server({ name: "kairos", version: "0.1.0" }, { capabilities: { tools: {} } })
  // Reset the cached connection on ANY call error so the next call reconnects —
  // otherwise a daemon restart leaves a dead cached client and every subsequent
  // tool call fails forever (the bridge outlives a daemon bounce).
  const dropClient = () => { clientPromise = null }
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    blog("tools/list")
    try { const { tools } = await (await daemonClient()).listTools(); blog(`tools/list → ${tools.length}`); return { tools } }
    catch (e) { dropClient(); blog(`tools/list err: ${String((e as Error)?.message ?? e)}`); return { tools: [] } }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    blog(`tools/call ${req.params.name}`)
    try { return await (await daemonClient()).callTool({ name: req.params.name, arguments: req.params.arguments ?? {} }) }
    catch (e) { dropClient(); return { isError: true, content: [{ type: "text", text: `bridge upstream error: ${String((e as Error)?.message ?? e)}` }] } }
  })

  await server.connect(new StdioServerTransport())
  blog("stdio server ready")
  process.stdin.resume()   // keep alive until codex closes stdin
}

main().catch((e) => {
  process.stderr.write(`[mcp-stdio-bridge] fatal: ${String((e as Error)?.message ?? e)}\n`)
  process.exit(1)
})

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

async function main() {
  // ── client → daemon /mcp (the SDK HTTP client; proven reliable) ──
  const clientTransport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
  })
  const client = new Client({ name: "kairos-stdio-bridge", version: "0.1.0" }, { capabilities: {} })
  await client.connect(clientTransport)

  // ── server ← codex (stdio) — forward list/call straight through ──
  const server = new Server({ name: "kairos", version: "0.1.0" }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools } = await client.listTools()
    return { tools }
  })
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return await client.callTool({ name: req.params.name, arguments: req.params.arguments ?? {} })
  })

  await server.connect(new StdioServerTransport())
  // Keep alive until stdin closes (codex owns our lifecycle).
  process.stdin.resume()
}

main().catch((e) => {
  process.stderr.write(`[mcp-stdio-bridge] fatal: ${String((e as Error)?.message ?? e)}\n`)
  process.exit(1)
})

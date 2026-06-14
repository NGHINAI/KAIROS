#!/usr/bin/env bun
// Shared smoke-test MCP server for the qwen-code vs opencode hands-on eval.
// Exposes ONE tool, read_screen, and APPENDS to a marker file every time it's
// actually called — so a tool-call landing is PROVABLE even if we can't parse the
// CLI's stream. stdio transport (each CLI spawns its own instance). Run with:
//   KAIROS_SMOKE_MARKER=/tmp/x.log bun /abs/path/_smoke-mcp.mjs
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { appendFileSync } from "node:fs"

const MARKER = process.env.KAIROS_SMOKE_MARKER || "/tmp/kairos-smoke-marker.log"
function mark(line) { try { appendFileSync(MARKER, line + "\n") } catch { /* */ } }
mark(`SERVER_START pid=${process.pid}`)

const SCREEN = "CURRENT SCREEN: SettingsApp. Visible elements: 1) Appearance, 2) Wallpaper, 3) Sound. The Appearance row controls Light/Dark mode."

const server = new Server({ name: "kairossmoke", version: "0.1.0" }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => {
  mark("TOOLS_LIST")
  return {
    tools: [{
      name: "read_screen",
      description: "Read what is currently on the user's screen. Returns a text summary of the visible app and its UI elements. Call this whenever the user asks what is on their screen or to see their display.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }],
  }
})
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  mark(`TOOLS_CALL name=${req.params.name} args=${JSON.stringify(req.params.arguments ?? {})}`)
  if (req.params.name === "read_screen") return { content: [{ type: "text", text: SCREEN }] }
  return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] }
})

await server.connect(new StdioServerTransport())
process.stdin.resume()

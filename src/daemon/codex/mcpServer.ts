// mcpServer.ts — the in-process MCP server Codex connects to (doc 08 §B, 14 §A4).
// It exposes the EXACT same toolset the in-house loop uses (buildActionToolset),
// so the Codex brain and the legacy loop call byte-identical tools. Mounted on the
// daemon's own Bun.serve at /mcp (NOT a `bun run` child — the tools close over live
// daemon singletons), over the Web-Standard Streamable-HTTP transport (works on
// Bun.serve's Request/Response; the Node StreamableHTTPServerTransport does not).
//
// Security (14 §B): bearer auth on every request (timing-safe), and a per-mode
// toolFilter so UNATTENDED/proactive turns get a restrained read/draft-only subset
// while the MCP layer (this) AND the sandbox both enforce it.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { timingSafeEqual } from "node:crypto"
import { buildActionToolset, type ActionToolDeps } from "../agents/buildActionToolset"
import type { ToolDef } from "../agents/types"

export interface KairosMcpOptions {
  /** Fresh deps per request — the toolset is DYNAMIC (Composio connects at runtime). */
  deps: () => ActionToolDeps
  /** Required bearer token (KAIROS_MCP_TOKEN). When set, every request must carry it. */
  bearerToken?: string
  /** Restrained-subset gate for unattended/proactive turns (12 §C): return false to
   *  hide/deny a tool. Omit for the full interactive surface. */
  toolFilter?: (name: string) => boolean
  /** Max concurrent MCP sessions before LRU eviction (default 64). Guards the
   *  unbounded-session-map leak: the stdio bridge dies per codex turn without
   *  sending DELETE, so without a cap + idle-sweep + onclose eviction, every turn
   *  pins a {server,transport} pair forever. */
  maxSessions?: number
  /** Evict sessions idle longer than this (ms, default 10min). */
  sessionTtlMs?: number
  log?: (msg: string) => void
}

/** Constant-time bearer compare (avoids leaking the token via timing). */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  try { return timingSafeEqual(ab, bb) } catch { return false }
}

/** A raw JSON Schema → a valid MCP inputSchema (object schema). */
function toInputSchema(parameters: any): Record<string, unknown> {
  if (parameters && typeof parameters === "object" && parameters.type) return parameters
  return { type: "object", properties: {} }
}

/** MCP tool result from a ToolDef.execute return (string → text; else JSON text). */
function toCallResult(result: unknown): { content: Array<{ type: "text"; text: string }> } {
  const text = typeof result === "string" ? result : JSON.stringify(result ?? null)
  return { content: [{ type: "text", text }] }
}

export interface KairosMcpServer {
  /** Route a /mcp Request here from the daemon's Bun.serve. */
  handleRequest: (req: Request) => Promise<Response>
  /** The resolved toolset right now (for diagnostics/tests). */
  listToolNames: () => Promise<string[]>
  /** Live MCP session count (for diagnostics/tests — guards the leak). */
  sessionCount: () => number
  close: () => Promise<void>
}

export function createKairosMcpServer(opts: KairosMcpOptions): KairosMcpServer {
  const log = opts.log ?? (() => {})
  const allowed = (name: string) => !opts.toolFilter || opts.toolFilter(name)

  // A configured Server (tools/list + tools/call) per session. The Web-Standard
  // transport instance is single-use in stateless mode and session-scoped in
  // stateful mode, so we keep ONE (server, transport) pair per MCP session,
  // created on `initialize` and reused for the follow-up notification + calls.
  function buildServer(): Server {
    const server = new Server({ name: "kairos", version: "0.1.0" }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = (await buildActionToolset(opts.deps())).filter((t) => allowed(t.name))
      if (process.env.KAIROS_MCP_DEBUG) log(`[mcp] tools/list → ${tools.length} tools`)
      return { tools: tools.map((t: ToolDef) => ({ name: t.name, description: t.description, inputSchema: toInputSchema(t.parameters) })) }
    })
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name
      const args = (req.params.arguments ?? {}) as Record<string, unknown>
      if (!allowed(name)) return { isError: true, content: [{ type: "text", text: `Tool "${name}" is not permitted in this mode.` }] }
      if (process.env.KAIROS_MCP_DEBUG) log(`[mcp] tools/call → ${name}`)
      const tools = await buildActionToolset(opts.deps())
      const tool = tools.find((t) => t.name === name)
      if (!tool) return { isError: true, content: [{ type: "text", text: `Unknown tool "${name}".` }] }
      try { return toCallResult(await tool.execute(args)) }
      catch (e) { return { isError: true, content: [{ type: "text", text: String((e as Error)?.message ?? e) }] } }
    })
    return server
  }

  interface Session { server: Server; transport: WebStandardStreamableHTTPServerTransport; lastSeen: number }
  const sessions = new Map<string, Session>()
  const maxSessions = opts.maxSessions ?? 64
  const ttlMs = opts.sessionTtlMs ?? 10 * 60_000

  async function evict(id: string): Promise<void> {
    const s = sessions.get(id)
    if (!s) return
    sessions.delete(id)
    try { await s.server.close() } catch { /* */ }
  }

  // Idle sweep — evicts sessions whose client (the stdio bridge, which never sends
  // DELETE) has gone away. Unref'd so it never keeps the process alive.
  const sweep = setInterval(() => {
    const cutoff = Date.now() - ttlMs
    for (const [id, s] of sessions) if (s.lastSeen < cutoff) void evict(id)
  }, 60_000)
  ;(sweep as any).unref?.()

  async function handleRequest(req: Request): Promise<Response> {
    if (process.env.KAIROS_MCP_DEBUG) log(`[mcp] ${req.method} accept=${req.headers.get("accept") ?? "-"} sid=${req.headers.get("mcp-session-id") ?? "-"} ct=${req.headers.get("content-type") ?? "-"}`)
    if (opts.bearerToken) {
      const got = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")
      if (!got || !safeEqual(got, opts.bearerToken)) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } })
      }
    }
    try {
      // Existing session → route to its transport (refresh lastSeen).
      const sid = req.headers.get("mcp-session-id")
      const existing = sid ? sessions.get(sid) : undefined
      if (existing) { existing.lastSeen = Date.now(); return await existing.transport.handleRequest(req) }

      // New session (initialize): evict LRU if at the cap, then mint a pair.
      while (sessions.size >= maxSessions) {
        let oldest: string | undefined; let oldestSeen = Infinity
        for (const [id, s] of sessions) if (s.lastSeen < oldestSeen) { oldestSeen = s.lastSeen; oldest = id }
        if (oldest) await evict(oldest); else break
      }
      const server = buildServer()
      const transport: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => { sessions.set(id, { server, transport, lastSeen: Date.now() }) },
        onsessionclosed: (id: string) => { void evict(id) },
      })
      // A dropped connection (the bridge process dying when codex closes stdin)
      // fires onclose — free the entry even without an explicit DELETE.
      transport.onclose = () => { if (transport.sessionId) void evict(transport.sessionId) }
      await server.connect(transport)
      return await transport.handleRequest(req)
    } catch (e) {
      log(`[mcp] handleRequest error: ${String((e as Error)?.message ?? e)}`)
      return new Response(JSON.stringify({ error: "mcp_internal_error" }), { status: 500, headers: { "content-type": "application/json" } })
    }
  }

  return {
    handleRequest,
    listToolNames: async () => (await buildActionToolset(opts.deps())).filter((t) => allowed(t.name)).map((t) => t.name),
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweep)
      for (const id of [...sessions.keys()]) await evict(id)
    },
  }
}

// mcpServer.test.ts — END-TO-END: a real MCP client (the SDK Client) talks to our
// in-process server over the actual Web-Standard Streamable-HTTP transport through
// a live Bun.serve. Proves the Codex-facing bridge lists + calls KAIROS tools,
// enforces the bearer, and honors the unattended restrained-subset filter.
import { afterAll, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createKairosMcpServer, type KairosMcpOptions } from "./mcpServer"
import type { ActionToolDeps } from "../agents/buildActionToolset"

// Deterministic offline deps: a fake guideBridge so read_screen returns a known
// summary; web disabled (no network); a fake memory injector. No Composio/net.
function deps(): ActionToolDeps {
  return {
    webSearchEnabled: false,
    memoryInjector: { inject: async () => [] },
    guideBridge: {
      request: async () => ({ found: true, label: "X" }),
      requestScreen: async () => ({ found: true, summary: "App: TestApp\nButtons: 1 Hello" }),
      requestWatch: async () => ({ found: true }),
    },
    log: () => {},
  }
}

const servers: Array<{ stop: () => void }> = []
const mcpServers: Array<{ close: () => Promise<void> }> = []

// Spin our MCP server behind a real Bun.serve on an ephemeral port.
function serve(opts: Partial<KairosMcpOptions> = {}) {
  const mcp = createKairosMcpServer({ deps, bearerToken: "test-token", ...opts })
  mcpServers.push(mcp)
  const httpd = Bun.serve({
    port: 0,
    fetch: (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/mcp") return mcp.handleRequest(req)
      return new Response("not found", { status: 404 })
    },
  })
  servers.push(httpd)
  return { url: `http://localhost:${httpd.port}/mcp`, mcp }
}

async function connectClient(url: string, token: string | null) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
  })
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} })
  await client.connect(transport)
  return client
}

afterAll(() => {
  for (const s of servers) try { s.stop() } catch { /* */ }
  for (const m of mcpServers) m.close().catch(() => {})
})

describe("KAIROS MCP server — end to end over real transport", () => {
  test("a real MCP client lists the KAIROS toolset", async () => {
    const { url } = serve()
    const client = await connectClient(url, "test-token")
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    expect(names).toContain("read_screen")
    expect(names).toContain("guide_user")
    // each advertised tool carries an object inputSchema
    for (const t of tools) expect((t.inputSchema as any)?.type).toBe("object")
    await client.close()
  })

  test("a real MCP client CALLS a tool and gets the grounded result", async () => {
    const { url } = serve()
    const client = await connectClient(url, "test-token")
    const res: any = await client.callTool({ name: "read_screen", arguments: {} })
    const text = res.content.map((c: any) => c.text).join("")
    expect(text).toContain("TestApp")          // our fake screen summary flowed back through MCP
    expect(res.isError).toBeFalsy()
    await client.close()
  })

  test("calling an unknown tool returns an MCP error, not a crash", async () => {
    const { url } = serve()
    const client = await connectClient(url, "test-token")
    const res: any = await client.callTool({ name: "no_such_tool", arguments: {} })
    expect(res.isError).toBe(true)
    await client.close()
  })

  test("bearer auth: wrong/missing token is rejected (401 → connect fails)", async () => {
    const { url } = serve()
    await expect(connectClient(url, "WRONG")).rejects.toThrow()
    await expect(connectClient(url, null)).rejects.toThrow()
  })

  test("restrained-subset (12§C): toolFilter hides + denies the disallowed tool", async () => {
    // Unattended posture: deny guide_user (an act-ish tool), allow read_screen.
    const { url } = serve({ toolFilter: (n) => n !== "guide_user" })
    const client = await connectClient(url, "test-token")
    const names = (await client.listTools()).tools.map((t) => t.name)
    expect(names).toContain("read_screen")
    expect(names).not.toContain("guide_user")     // hidden from the list
    const res: any = await client.callTool({ name: "guide_user", arguments: { find: "X" } })
    expect(res.isError).toBe(true)                  // and denied if called directly
    await client.close()
  })
})

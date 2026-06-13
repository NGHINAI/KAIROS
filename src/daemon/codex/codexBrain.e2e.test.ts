// codexBrain.e2e.test.ts — THE make-or-break live proof (A4.4). Gated behind
// KAIROS_E2E=1 (needs the real codex binary + network + KAIROS_BRAIN_KEY), so it
// SKIPS in normal `bun test`/CI. Run it with:
//   KAIROS_E2E=1 bun test src/daemon/codex/codexBrain.e2e.test.ts
//
// It stands up a SELF-CONTAINED harness on an ephemeral port (NOT the live daemon):
//   • /mcp        → our real createKairosMcpServer with offline deps (instrumented
//                   read_screen so we can SEE a tools/call land)
//   • /brain/*    → our real createBrainProxy → OpenRouter (real key, alias rewrite)
// generates a CODEX_HOME via ensureCodexHome pointed at both, spawns a REAL
// `codex app-server` through CodexBrain, and drives a turn that must call a KAIROS
// tool. Proves the A3 blocker is gone on the correct lane: a real tools/call reaches
// our MCP server through the stdio bridge under sandbox+network_access, AND the model
// path works through the hidden proxy.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createKairosMcpServer } from "./mcpServer"
import { createBrainProxy, defaultAliasMap } from "./brainProxy"
import { ensureCodexHome } from "./codexHome"
import { createCodexBrain, spawnCodexAppServer, buildCodexChildEnv } from "./codexBrain"
import type { ActionToolDeps } from "../agents/buildActionToolset"

const RUN = process.env.KAIROS_E2E === "1"
const BRAIN_KEY = process.env.KAIROS_BRAIN_KEY ?? ""

const servers: Array<{ stop: () => void }> = []
const brains: Array<{ shutdown: () => void }> = []
afterAll(() => { for (const s of servers) try { s.stop() } catch {} ; for (const b of brains) try { b.shutdown() } catch {} })

describe.skipIf(!RUN || !BRAIN_KEY)("CodexBrain LIVE E2E — real app-server → /brain + /mcp", () => {
  test("a real codex turn calls a KAIROS MCP tool (tools/call lands) and answers from it", async () => {
    // ── instrumented offline deps: record when read_screen is actually invoked ──
    let readScreenCalls = 0
    const deps = (): ActionToolDeps => ({
      webSearchEnabled: false,
      memoryInjector: { inject: async () => [] },
      guideBridge: {
        request: async () => ({ found: true, label: "X" }),
        requestScreen: async () => { readScreenCalls++; return { found: true, summary: "App: SettingsApp\nButtons: 1 Appearance, 2 Wallpaper" } },
        requestWatch: async () => ({ found: true }),
      },
      log: () => {},
    })

    const mcpToken = "e2e-mcp-token-" + Math.floor(performance.now())
    const mcp = createKairosMcpServer({ deps, bearerToken: mcpToken })

    const proxy = createBrainProxy({
      upstreamKey: BRAIN_KEY,
      expectedBearer: BRAIN_KEY,           // dev: codex sends the same token it forwards with
      aliasMap: defaultAliasMap(process.env),
    })

    // One Bun.serve hosting BOTH mounts on an ephemeral port.
    const httpd = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: (req) => {
        const url = new URL(req.url)
        if (url.pathname === "/mcp") return mcp.handleRequest(req)
        if (url.pathname.startsWith("/brain/")) return proxy.handleRequest(req, url.pathname.slice("/brain".length) + url.search)
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(httpd)
    const port = httpd.port
    // eslint-disable-next-line no-console
    console.log(`[e2e] harness on 127.0.0.1:${port} (/mcp + /brain) — model=${defaultAliasMap(process.env)["kairos-smart"]}`)

    // ── generate an isolated CODEX_HOME pointed at our harness ──
    const root = mkdtempSync(join(tmpdir(), "kairos-e2e-codex-"))
    const bridgeScript = resolve(import.meta.dir, "mcpStdioBridge.ts")
    const home = await ensureCodexHome({
      root,
      baseUrl: `http://127.0.0.1:${port}/brain/v1`,   // codex appends /responses → /brain/v1/responses → strip → /v1/responses → OpenRouter
      brainKeyEnv: "KAIROS_BRAIN_KEY",
      modelAlias: "kairos-smart",
      mcpUrl: `http://127.0.0.1:${port}/mcp`,
      mcpToken,
      bunPath: process.execPath,                       // the running bun
      bridgeScript,
    })

    // ── drive a REAL codex app-server through CodexBrain ──
    const childEnv = buildCodexChildEnv({
      brainKey: BRAIN_KEY,
      mcpToken,
      codexHome: home.home,
      home: process.env.HOME ?? "/tmp",
      pathDir: "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin",   // dev: rg + git + codex resolve here
    })
    const brain = createCodexBrain({
      connect: () => spawnCodexAppServer({
        binaryPath: "/opt/homebrew/bin/codex",
        workspaceDir: home.workspace,
        env: childEnv,
        log: (m) => console.log(`[e2e codex] ${m}`),
      }),
      modelAlias: "kairos-smart",
      baseInstructions:
        "You are KAIROS. You can see the user's screen ONLY by calling the `read_screen` tool. " +
        "When the user asks what is on their screen, you MUST call read_screen and answer strictly from its result. Never guess.",
      effort: "low",
      workspaceDir: home.workspace,
      turnTimeoutMs: 120_000,
      log: (m) => console.log(`[e2e brain] ${m}`),
    })
    brains.push(brain)

    const events: string[] = []
    const res = await brain.run("What's on my screen right now? Use your tools to check.", {
      tools: [],
      instructions: "",
      onEvent: (e) => events.push(e.kind),
    })

    console.log(`[e2e] readScreenCalls=${readScreenCalls} finalOutput=${JSON.stringify(res.finalOutput).slice(0, 300)} toolCalls=${JSON.stringify(res.toolCalls.map((c) => c.name))}`)

    // THE PROOF: a real tools/call for read_screen reached our MCP server.
    expect(readScreenCalls).toBeGreaterThan(0)
    // ...and the brain saw the tool call in its ledger + produced a non-empty answer.
    expect(res.toolCalls.some((c) => c.name === "read_screen")).toBe(true)
    expect(res.finalOutput.length).toBeGreaterThan(0)
  }, 180_000)
})

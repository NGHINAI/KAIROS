// openCodeBrain.e2e.test.ts — LIVE proof of the PRODUCTION path (B3). Gated behind
// KAIROS_E2E=1 (needs the opencode binary + network + KAIROS_BRAIN_KEY); SKIPS in CI.
//   KAIROS_E2E=1 bun test src/daemon/opencode/openCodeBrain.e2e.test.ts
//
// Drives a REAL turn through OpenCodeBrain.run() → spawnOpenCode (real `opencode serve`)
// → minimax via OpenRouter → calls KAIROS's REAL mcpServer (/mcp, Streamable-HTTP, remote)
// → result round-trips → LoopEvents stream → PlannerRunner result. This validates the
// whole brain end-to-end the way the conductor will use it (deps.runPlanner).
import { afterAll, describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { createKairosMcpServer } from "../codex/mcpServer"
import { createBrainProxy } from "../codex/brainProxy"
import { createOpenCodeBrain, spawnOpenCode, buildOpenCodeConfig } from "./openCodeBrain"
import type { ActionToolDeps } from "../agents/buildActionToolset"
import type { LoopEvent } from "../agents/loop/types"

const RUN = process.env.KAIROS_E2E === "1"
const BRAIN_KEY = process.env.KAIROS_BRAIN_KEY ?? ""
// Ensure the bundled opencode binary is on PATH for createOpencode to spawn `opencode serve`.
process.env.PATH = `${resolve(import.meta.dir, "../../../node_modules/.bin")}:${process.env.PATH}`

const servers: Array<{ stop: () => void }> = []
const brains: Array<{ shutdown: () => void }> = []
afterAll(() => { for (const s of servers) try { s.stop() } catch {} ; for (const b of brains) try { b.shutdown() } catch {} })

describe.skipIf(!RUN || !BRAIN_KEY)("OpenCodeBrain LIVE E2E — real opencode + minimax + KAIROS /mcp", () => {
  test("a real turn calls a KAIROS MCP tool (round-trip) and streams LoopEvents", async () => {
    let readScreenCalls = 0
    const deps = (): ActionToolDeps => ({
      webSearchEnabled: false,
      memoryInjector: { inject: async () => [] },
      guideBridge: {
        request: async () => ({ found: true, label: "X" }),
        requestScreen: async () => { readScreenCalls++; return { found: true, summary: "App: SettingsApp\nButtons: 1 Appearance, 2 Wallpaper, 3 Sound" } },
        requestWatch: async () => ({ found: true }),
      },
      log: () => {},
    })
    const mcpToken = "e2e-oc-" + Math.floor(performance.now())
    const mcp = createKairosMcpServer({ deps, bearerToken: mcpToken })
    // D4: the PRODUCTION path — opencode talks to our hidden /brain proxy with the model
    // ALIAS "kairos-smart" (the proxy maps it to the real slug + injects the upstream key),
    // so nothing in opencode's config/requests names OpenRouter or the real model.
    const proxy = createBrainProxy({ upstreamKey: BRAIN_KEY, expectedBearer: BRAIN_KEY, aliasMap: { "kairos-smart": "minimax/minimax-m3" } })
    const httpd = Bun.serve({
      port: 0, idleTimeout: 0,
      fetch: (req) => {
        const u = new URL(req.url)
        if (u.pathname === "/mcp") return mcp.handleRequest(req)
        if (u.pathname.startsWith("/brain/")) return proxy.handleRequest(req, u.pathname.slice("/brain".length) + u.search)
        return new Response("nf", { status: 404 })
      },
    })
    servers.push(httpd)
    const mcpUrl = `http://127.0.0.1:${httpd.port}/mcp`
    console.log(`[e2e] KAIROS /mcp + /brain at 127.0.0.1:${httpd.port}`)

    const config = buildOpenCodeConfig({
      brainKey: BRAIN_KEY,
      baseURL: `http://127.0.0.1:${httpd.port}/brain/v1`,   // hidden proxy, not OpenRouter directly
      modelProviderID: "kairosbrain",
      modelID: "kairos-smart",                               // alias → resolved by the proxy
      mcpServerName: "kairos",
      mcpUrl,
      mcpToken,
    })
    const brain = createOpenCodeBrain({
      connect: () => spawnOpenCode({ config, log: (m) => console.log(`[oc] ${m}`) }),
      modelProviderID: "kairosbrain",
      modelID: "kairos-smart",
      mcpServerName: "kairos",
      baseInstructions:
        "You are KAIROS. You can see the user's screen ONLY by calling the read_screen tool. " +
        "When the user asks what is on their screen you MUST call read_screen and answer strictly from its result.",
      verifier: { verify: async () => ({ ok: true, severity: "read" }) }, // isolate the brain path
      turnTimeoutMs: 120_000,
      log: (m) => console.log(`[brain] ${m}`),
    })
    brains.push(brain)

    const events: LoopEvent[] = []
    const res = await brain.run("What is currently on my screen right now? Use your tools to check, then tell me exactly what you see.", {
      tools: [], instructions: "", onEvent: (e) => events.push(e),
    })

    console.log(`[e2e] readScreenCalls=${readScreenCalls} toolCalls=${JSON.stringify(res.toolCalls.map((c) => c.name))} final=${JSON.stringify(res.finalOutput).slice(0, 300)}`)
    const kinds = events.map((e) => e.kind)
    console.log(`[e2e] LoopEvent kinds: ${JSON.stringify([...new Set(kinds)])}`)

    // THE PROOF: a real tools/call for read_screen reached our MCP server,
    expect(readScreenCalls).toBeGreaterThan(0)
    // ...the brain saw it in its ledger (namespace stripped),
    expect(res.toolCalls.some((c) => c.name === "read_screen")).toBe(true)
    // ...LoopEvents streamed, and a real answer came back.
    expect(kinds).toContain("tool_call_start")
    expect(res.finalOutput.length).toBeGreaterThan(0)
  }, 180_000)
})

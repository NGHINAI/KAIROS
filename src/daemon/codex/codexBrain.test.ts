// codexBrain.test.ts — the warm `codex app-server` driver as a PlannerRunner.
// Pure helpers (minimal-env spawn [B6], turn input, thread/turn params) are unit
// tested; the full lifecycle (initialize → thread/start → turn/start → notification
// stream → post-turn verifier → corrective retry) is proven against a SCRIPTED FAKE
// app-server that speaks the real wire shape through the real codexJsonRpc transport.
import { describe, expect, test } from "bun:test"
import {
  createCodexBrain,
  buildCodexChildEnv,
  buildTurnInput,
  type CodexProcessHandle,
} from "./codexBrain"
import { createCodexRpc } from "./codexJsonRpc"
import { setToolNature } from "../agents/loop/verifier"
import type { LoopEvent } from "../agents/loop/types"

// ── a scripted fake app-server ────────────────────────────────────────────────
// Speaks loose JSON-RPC through the REAL transport: intercepts `send`, auto-answers
// initialize/thread/start/inject_items/turn/interrupt, and on each turn/start runs
// the supplied `script(turnId, push, reqFrame)` to emit the notification stream.
type Push = (method: string, params: any) => void
function makeFakeServer(script: (turnId: string, push: Push, reqFrame: any) => void) {
  const sent: any[] = []
  let rpc: ReturnType<typeof createCodexRpc>
  let turnCount = 0
  const push: Push = (method, params) => rpc.receive(JSON.stringify({ method, params }) + "\n")
  const respond = (id: any, result: any) => rpc.receive(JSON.stringify({ id, result }) + "\n")
  rpc = createCodexRpc({
    send: (line) => {
      const f = JSON.parse(line)
      sent.push(f)
      if (f.id === undefined) return // notification (e.g. `initialized`) — no reply
      queueMicrotask(() => {
        switch (f.method) {
          case "initialize": return respond(f.id, { userAgent: "fake/0.133", codexHome: "/tmp", platformFamily: "unix", platformOs: "macos" })
          case "thread/start": return respond(f.id, { thread: { id: "thread-1" }, model: "kairos", modelProvider: "kairos" })
          case "thread/inject_items": return respond(f.id, {})
          case "turn/interrupt": return respond(f.id, {})
          case "turn/start": {
            const turnId = `turn-${++turnCount}`
            respond(f.id, { turn: { id: turnId } })
            script(turnId, push, f)
            return
          }
          default: return respond(f.id, {})
        }
      })
    },
  })
  const handle: CodexProcessHandle = { rpc, kill: () => {}, exited: new Promise(() => {}) }
  return { handle, sent, connect: () => handle }
}

// A normal turn: stream a delta, call read_screen, stream more, finalize, complete.
function normalTurn(finalText = "All set."): (turnId: string, push: Push) => void {
  return (turnId, push) => {
    push("turn/started", { turn: { id: turnId } })
    push("item/agentMessage/delta", { itemId: "m1", delta: "On it. " })
    push("item/started", { item: { type: "mcpToolCall", id: "c1", server: "kairos", tool: "read_screen", status: "inProgress", arguments: {} } })
    push("item/completed", { item: { type: "mcpToolCall", id: "c1", server: "kairos", tool: "read_screen", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "CURRENT SCREEN: System Settings" }], structuredContent: null, _meta: null }, error: null } })
    push("item/completed", { item: { type: "agentMessage", id: "m1", text: finalText, phase: null, memoryCitation: null } })
    push("turn/completed", { turn: { id: turnId, status: "completed" } })
  }
}

const okVerifier = { verify: async () => ({ ok: true, severity: "read" as const }) }

function brainWith(connect: () => CodexProcessHandle, extra: Partial<Parameters<typeof createCodexBrain>[0]> = {}) {
  return createCodexBrain({
    connect,
    modelAlias: "kairos-smart",
    baseInstructions: "You are KAIROS. Be witty.",
    effort: "low",
    workspaceDir: "/tmp/ws",
    verifier: okVerifier,
    ...extra,
  })
}

describe("codexBrain — pure helpers", () => {
  test("buildCodexChildEnv (B6) is a MINIMAL allowlist — no daemon/provider secrets leak", () => {
    const env = buildCodexChildEnv({
      brainKey: "proxy-token-xyz",
      mcpToken: "mcp-tok",
      codexHome: "/state/codex/home",
      home: "/Users/x",
      pathDir: "/vendor/path",
      processEnv: { OPENROUTER_API_KEY: "sk-or-LEAK", COMPOSIO_API_KEY: "leak2", PATH: "/usr/bin", FOO: "bar" },
    })
    // exactly the allowlisted keys
    expect(new Set(Object.keys(env))).toEqual(new Set(["KAIROS_BRAIN_KEY", "KAIROS_MCP_TOKEN", "OPENAI_API_KEY", "CODEX_HOME", "PATH", "HOME"]))
    expect(env.KAIROS_BRAIN_KEY).toBe("proxy-token-xyz")
    expect(env.OPENAI_API_KEY).toBe("proxy-token-xyz")   // codex reads its key as OPENAI_API_KEY → the proxy token, never a provider key
    expect(env.PATH).toBe("/vendor/path")                // vendored runtime dir ONLY, not inherited PATH
    // the leak-vectors are ABSENT
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY")
    expect(env).not.toHaveProperty("COMPOSIO_API_KEY")
    expect(env).not.toHaveProperty("FOO")
  })

  test("buildTurnInput produces the UserInput text shape codex expects", () => {
    expect(buildTurnInput("hello")).toEqual([{ type: "text", text: "hello", text_elements: [] }])
  })
})

describe("codexBrain — full lifecycle against a fake app-server", () => {
  test("run() does initialize → thread/start → turn/start and returns the final answer", async () => {
    const fake = makeFakeServer(normalTurn("All set."))
    const brain = brainWith(fake.connect)
    const events: LoopEvent[] = []
    const res = await brain.run("switch to dark mode", { tools: [], instructions: "ignored-per-turn", onEvent: (e) => events.push(e) })

    expect(res.finalOutput).toBe("All set.")
    expect(res.streamedText).toBe("On it. ")
    expect(res.toolCalls.map((c) => c.name)).toEqual(["read_screen"])

    const methods = fake.sent.map((f) => f.method)
    expect(methods).toContain("initialize")
    expect(methods).toContain("initialized")
    expect(methods).toContain("thread/start")
    expect(methods).toContain("turn/start")
    // initialize precedes thread/start precedes turn/start
    expect(methods.indexOf("initialize")).toBeLessThan(methods.indexOf("thread/start"))
    expect(methods.indexOf("thread/start")).toBeLessThan(methods.indexOf("turn/start"))
  })

  test("thread/start carries the durable persona + provider + never-approval policy", async () => {
    const fake = makeFakeServer(normalTurn())
    await brainWith(fake.connect).run("hi", { tools: [], instructions: "" })
    const ts = fake.sent.find((f) => f.method === "thread/start")!
    expect(ts.params.baseInstructions).toBe("You are KAIROS. Be witty.")
    expect(ts.params.modelProvider).toBe("kairos")
    expect(ts.params.model).toBe("kairos-smart")
    expect(ts.params.approvalPolicy).toBe("never")
    expect(ts.params.sandbox).toBe("workspace-write")
  })

  test("turn/start carries the per-turn effort + the utterance as input", async () => {
    const fake = makeFakeServer(normalTurn())
    await brainWith(fake.connect, { effort: "high" }).run("think hard", { tools: [], instructions: "" })
    const turn = fake.sent.find((f) => f.method === "turn/start")!
    expect(turn.params.effort).toBe("high")
    expect(turn.params.input).toEqual([{ type: "text", text: "think hard", text_elements: [] }])
    expect(turn.params.threadId).toBe("thread-1")
  })

  test("LoopEvents stream in order: delta → tool_call_start → tool_call_done", async () => {
    const fake = makeFakeServer(normalTurn())
    const events: LoopEvent[] = []
    await brainWith(fake.connect).run("x", { tools: [], instructions: "", onEvent: (e) => events.push(e) })
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain("assistant_delta")
    expect(kinds.indexOf("tool_call_start")).toBeLessThan(kinds.indexOf("tool_call_done"))
  })

  test("the same conversationId reuses ONE thread across two turns", async () => {
    const fake = makeFakeServer(normalTurn())
    const brain = brainWith(fake.connect)
    await brain.run("one", { tools: [], instructions: "", conversationId: "conv-A" } as any)
    await brain.run("two", { tools: [], instructions: "", conversationId: "conv-A" } as any)
    expect(fake.sent.filter((f) => f.method === "thread/start")).toHaveLength(1)
    expect(fake.sent.filter((f) => f.method === "turn/start")).toHaveLength(2)
  })

  test("post-turn verifier flagging retryable starts a NEW corrective turn/start and marks corrected", async () => {
    const fake = makeFakeServer(normalTurn("I'm highlighting it."))
    let calls = 0
    const verifier = {
      verify: async () => {
        calls++
        return calls === 1
          ? { ok: false, severity: "read" as const, retryable: true, concern: "claimed an on-screen action with no successful tool" }
          : { ok: true, severity: "read" as const }
      },
    }
    const events: LoopEvent[] = []
    const res = await brainWith(fake.connect, { verifier }).run("switch", { tools: [], instructions: "", onEvent: (e) => events.push(e) })
    expect(fake.sent.filter((f) => f.method === "turn/start")).toHaveLength(2)   // original + corrective
    expect(res.corrected).toBe(true)
    expect(events.some((e) => e.kind === "self_correct")).toBe(true)
  })

  test("verifier ok → no corrective turn", async () => {
    const fake = makeFakeServer(normalTurn())
    const res = await brainWith(fake.connect).run("x", { tools: [], instructions: "" })
    expect(fake.sent.filter((f) => f.method === "turn/start")).toHaveLength(1)
    expect(res.corrected).toBeFalsy()
  })

  test("write-guard (C12): a corrective retry is SUPPRESSED once a destructive tool already succeeded", async () => {
    // The turn makes a successful destructive write, then the verifier flags retryable.
    // Re-running could double-send → the write-guard must block the corrective turn.
    const destructiveTurn = (turnId: string, push: Push) => {
      push("turn/started", { turn: { id: turnId } })
      push("item/started", { item: { type: "mcpToolCall", id: "w1", server: "kairos", tool: "GMAIL_SEND_EMAIL", status: "inProgress", arguments: {} } })
      push("item/completed", { item: { type: "mcpToolCall", id: "w1", server: "kairos", tool: "GMAIL_SEND_EMAIL", status: "completed", arguments: {}, result: { content: [{ type: "text", text: "sent" }], structuredContent: null, _meta: null }, error: null } })
      push("item/completed", { item: { type: "agentMessage", id: "m1", text: "Sent!", phase: null, memoryCitation: null } })
      push("turn/completed", { turn: { id: turnId, status: "completed" } })
    }
    const fake = makeFakeServer(destructiveTurn)
    const verifier = { verify: async () => ({ ok: false, severity: "write" as const, retryable: true, concern: "x" }) }
    // The write-guard keys on the runtime tool-nature map (the model's read/write
    // classification, set at boot). Give the test the same classification production has.
    setToolNature(new Map([["GMAIL_SEND_EMAIL", "write"]]))
    try {
      await brainWith(fake.connect, { verifier }).run("email bob", { tools: [], instructions: "" })
      expect(fake.sent.filter((f) => f.method === "turn/start")).toHaveLength(1) // NO corrective turn
    } finally {
      setToolNature(null) // reset global classification so other tests are unaffected
    }
  })

  test("an abort signal fires turn/interrupt and ends the run quietly", async () => {
    // A turn that streams a delta but never completes — abort must unstick it.
    const hangingTurn = (turnId: string, push: Push) => {
      push("turn/started", { turn: { id: turnId } })
      push("item/agentMessage/delta", { itemId: "m1", delta: "working" })
      // no turn/completed — the run hangs until aborted
    }
    const fake = makeFakeServer(hangingTurn)
    const ctrl = new AbortController()
    const brain = brainWith(fake.connect)
    const p = brain.run("do it", { tools: [], instructions: "", signal: ctrl.signal })
    await new Promise((r) => setTimeout(r, 20))
    ctrl.abort()
    await p
    expect(fake.sent.some((f) => f.method === "turn/interrupt")).toBe(true)
  })
})

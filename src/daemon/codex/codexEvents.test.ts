// codexEvents.test.ts — translate the codex app-server notification stream into
// KAIROS LoopEvents + reconstruct the (finalText, toolCalls ledger, plan, status)
// tuple the post-turn verifier consumes. Pure helpers + a stateful per-turn
// accumulator. Asserts the A3 invariant: the MCP namespace is stripped BEFORE the
// name ever reaches the verifier, so a Composio write can't masquerade as local/safe.
import { describe, expect, test } from "bun:test"
import { stripMcpNamespace, mcpResultText, createTurnAccumulator } from "./codexEvents"
import type { LoopEvent } from "../agents/loop/types"

// Build an accumulator wired to a captured event list.
function acc() {
  const events: LoopEvent[] = []
  const a = createTurnAccumulator((e) => events.push(e))
  return { a, events }
}

// Convenience builders for the app-server notification frames.
const delta = (text: string) => ["item/agentMessage/delta", { itemId: "m1", delta: text }] as const
const mcpStarted = (id: string, tool: string, args: any) =>
  ["item/started", { item: { type: "mcpToolCall", id, server: "kairos", tool, status: "inProgress", arguments: args } }] as const
const mcpDone = (id: string, tool: string, text: string) =>
  ["item/completed", { item: { type: "mcpToolCall", id, server: "kairos", tool, status: "completed", arguments: {}, result: { content: [{ type: "text", text }], structuredContent: null, _meta: null }, error: null } }] as const
const mcpFailed = (id: string, tool: string, message: string) =>
  ["item/completed", { item: { type: "mcpToolCall", id, server: "kairos", tool, status: "failed", arguments: {}, result: null, error: { message } } }] as const
const agentDone = (text: string) =>
  ["item/completed", { item: { type: "agentMessage", id: "m1", text, phase: null, memoryCitation: null } }] as const

describe("codexEvents — pure helpers", () => {
  test("stripMcpNamespace removes the kairos server prefix in both __ and . forms", () => {
    expect(stripMcpNamespace("kairos__GMAIL_SEND_EMAIL")).toBe("GMAIL_SEND_EMAIL")
    expect(stripMcpNamespace("kairos.read_screen")).toBe("read_screen")
    expect(stripMcpNamespace("read_screen")).toBe("read_screen")       // already bare
    expect(stripMcpNamespace("kairos__execute_tool")).toBe("execute_tool")
  })

  test("mcpResultText joins text content; tolerates structured/empty", () => {
    expect(mcpResultText({ content: [{ type: "text", text: "Pointing at General" }], structuredContent: null, _meta: null })).toBe("Pointing at General")
    expect(mcpResultText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }], structuredContent: null, _meta: null })).toBe("ab")
    expect(mcpResultText(null)).toBe("")
  })
})

describe("codexEvents — per-turn accumulator → LoopEvents + ledger", () => {
  test("agentMessage deltas stream as assistant_delta; completed item sets finalText", () => {
    const { a, events } = acc()
    a.handle(...delta("Hel"))
    a.handle(...delta("lo"))
    a.handle(...agentDone("Hello"))
    expect(events.filter((e) => e.kind === "assistant_delta")).toEqual([
      { kind: "assistant_delta", text: "Hel" },
      { kind: "assistant_delta", text: "lo" },
    ])
    expect(a.state().finalText).toBe("Hello")
    expect(a.state().streamedText).toBe("Hello")   // delta accumulation
  })

  test("mcpToolCall started→done emits tool_call_start then tool_call_done and records the ledger", () => {
    const { a, events } = acc()
    a.handle(...mcpStarted("c1", "read_screen", { foo: 1 }))
    a.handle(...mcpDone("c1", "read_screen", "CURRENT SCREEN: System Settings"))
    expect(events).toEqual([
      { kind: "tool_call_start", id: "c1", name: "read_screen", args: { foo: 1 } },
      { kind: "tool_call_done", id: "c1", name: "read_screen", result: "CURRENT SCREEN: System Settings" },
    ])
    const ledger = a.state().toolCalls
    expect(ledger).toHaveLength(1)
    expect(ledger[0]).toMatchObject({ id: "c1", name: "read_screen", args: { foo: 1 }, result: "CURRENT SCREEN: System Settings" })
  })

  test("a failed mcpToolCall emits tool_call_failed and records the error in the ledger", () => {
    const { a, events } = acc()
    a.handle(...mcpStarted("c2", "GMAIL_SEND_EMAIL", {}))
    a.handle(...mcpFailed("c2", "GMAIL_SEND_EMAIL", "not connected"))
    expect(events.at(-1)).toEqual({ kind: "tool_call_failed", id: "c2", name: "GMAIL_SEND_EMAIL", error: "not connected" })
    expect(a.state().toolCalls.at(-1)).toMatchObject({ name: "GMAIL_SEND_EMAIL", error: "not connected" })
  })

  test("A3 invariant: a namespaced tool name is STRIPPED before it reaches the ledger/verifier", () => {
    const { a, events } = acc()
    // codex could surface a server__tool form; strip it so the verifier sees the bare write name.
    a.handle("item/started", { item: { type: "mcpToolCall", id: "c3", server: "kairos", tool: "kairos__GMAIL_SEND_EMAIL", status: "inProgress", arguments: {} } })
    expect((events[0] as any).name).toBe("GMAIL_SEND_EMAIL")
    expect(a.state().toolCalls[0]!.name).toBe("GMAIL_SEND_EMAIL")
  })

  test("turn/plan/updated emits plan_update and records the plan", () => {
    const { a, events } = acc()
    a.handle("turn/plan/updated", { plan: [{ step: "look", status: "completed" }, { step: "point", status: "inProgress" }] })
    expect(events.at(-1)).toEqual({ kind: "plan_update", plan: [{ step: "look", status: "completed" }, { step: "point", status: "inProgress" }] })
    expect(a.state().plan).toHaveLength(2)
  })

  test("thread/compacted emits a compaction event", () => {
    const { a, events } = acc()
    a.handle("thread/compacted", {})
    expect(events.at(-1)!.kind).toBe("compaction")
  })

  test("turn/completed captures the terminal status", () => {
    const { a } = acc()
    a.handle("turn/completed", { turn: { id: "t1", status: "completed" } })
    expect(a.state().status).toBe("completed")
  })

  test("a native commandExecution maps to a run_shell tool_call (codex's sandboxed shell)", () => {
    const { a, events } = acc()
    a.handle("item/started", { item: { type: "commandExecution", id: "e1", command: "ls", status: "inProgress" } })
    a.handle("item/completed", { item: { type: "commandExecution", id: "e1", command: "ls", status: "completed", aggregatedOutput: "file.txt", exitCode: 0 } })
    expect(events[0]).toMatchObject({ kind: "tool_call_start", id: "e1", name: "run_shell" })
    expect(events.at(-1)).toMatchObject({ kind: "tool_call_done", id: "e1", name: "run_shell" })
    expect(a.state().toolCalls[0]!.name).toBe("run_shell")
  })

  test("item/started for an agentMessage is NOT treated as a tool call", () => {
    const { a, events } = acc()
    a.handle("item/started", { item: { type: "agentMessage", id: "m1", text: "", phase: null, memoryCitation: null } })
    expect(events).toHaveLength(0)
  })
})

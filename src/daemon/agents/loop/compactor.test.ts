// src/daemon/agents/loop/compactor.test.ts
import { test, expect } from "bun:test"
import { buildCompactor } from "./compactor"
import type { LoopMsg } from "./types"

// A realistic single-loop history: ONE user goal, then tool rounds (the loop never
// adds more user turns). Includes an update_plan so R7's plan-preservation applies.
const msgs: LoopMsg[] = [
  { role: "system", content: "You are KAIROS." },
  { role: "user", content: "find my linear issues and archive the first one" },
  { role: "assistant", content: "", tool_calls: [{ id: "p1", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ plan: [{ step: "find issues", status: "completed" }, { step: "archive first", status: "in_progress" }] }) } }] },
  { role: "tool", tool_call_id: "p1", content: "Plan updated (1/2 done)." },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "search_tools", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c1", content: "[lots of tool output]" },
  { role: "assistant", content: "", tool_calls: [{ id: "c2", type: "function", function: { name: "execute_tool", arguments: "{}" } }] },
  { role: "tool", tool_call_id: "c2", content: "[huge issues json — AJG-7 first]" },
]

test("under the token threshold, returns the SAME messages array (no compaction)", async () => {
  const c = buildCompactor({ summarize: async () => "SUMMARY", thresholdTokens: 100000 })
  const out = await c.maybeCompact(msgs, 5000)
  expect(out).toBe(msgs)
})

test("R7: over threshold → keeps system + summary + plan + goal + the LAST tool block (pairing intact)", async () => {
  const c = buildCompactor({ summarize: async () => "did search+list; 7 issues; AJG-7 is first", thresholdTokens: 1000 })
  const out = await c.maybeCompact(msgs, 5000)
  expect(out).not.toBe(msgs)
  expect(out[0]!.role).toBe("system")
  expect((out[0] as any).content).toContain("KAIROS")
  // summary present
  expect(out.some((m) => (m as any).content?.includes("AJG-7 is first"))).toBe(true)
  // R7: the goal is preserved verbatim
  expect(out.some((m) => m.role === "user" && (m as any).content.includes("find my linear issues"))).toBe(true)
  // R7: the current plan is carried forward
  expect(out.some((m) => m.role === "system" && (m as any).content?.includes("archive first"))).toBe(true)
  // R7: the LAST tool round (c2) is kept verbatim
  const toolMsgs = out.filter((m) => m.role === "tool") as any[]
  expect(toolMsgs.length).toBe(1)
  expect(toolMsgs[0].tool_call_id).toBe("c2")
  // and its matching assistant tool_calls turn is present → NO orphaned tool_call_id
  const asst = out.find((m) => m.role === "assistant" && (m as any).tool_calls) as any
  expect(asst.tool_calls[0].id).toBe("c2")
  // the EARLIER round (c1) was summarized away (dropped)
  expect(out.some((m) => m.role === "tool" && (m as any).tool_call_id === "c1")).toBe(false)
})

test("every kept tool message has a matching assistant tool_call (no orphans)", async () => {
  const c = buildCompactor({ summarize: async () => "s", thresholdTokens: 1 })
  const out = await c.maybeCompact(msgs, 9999)
  const callIds = new Set(out.filter((m) => m.role === "assistant").flatMap((m: any) => (m.tool_calls ?? []).map((t: any) => t.id)))
  for (const t of out.filter((m) => m.role === "tool") as any[]) {
    expect(callIds.has(t.tool_call_id)).toBe(true)
  }
})

test("VERIFY-FIX L1: a history ending in an UNANSWERED assistant tool_calls turn → no orphan kept", async () => {
  // The last assistant turn has tool_calls but no following tool responses (a pending
  // round). Keeping it would orphan the tool_call_id → provider 400. It must be dropped.
  const pending: LoopMsg[] = [
    { role: "system", content: "You are KAIROS." },
    { role: "user", content: "do it" },
    { role: "assistant", content: "", tool_calls: [{ id: "x1", type: "function", function: { name: "echo", arguments: "{}" } }] },
  ]
  const c = buildCompactor({ summarize: async () => "s", thresholdTokens: 1 })
  const out = await c.maybeCompact(pending, 9999)
  // no assistant-with-tool_calls and no tool message survive (the orphan was dropped)
  expect(out.some((m) => m.role === "assistant" && (m as any).tool_calls)).toBe(false)
  expect(out.some((m) => m.role === "tool")).toBe(false)
  expect(out.some((m) => m.role === "user" && (m as any).content === "do it")).toBe(true)
})

test("history with NO tool rounds compacts to [system, summary, goal] (no block)", async () => {
  const simple: LoopMsg[] = [
    { role: "system", content: "You are KAIROS." },
    { role: "user", content: "what's the weather" },
    { role: "assistant", content: "some long thinking..." },
  ]
  const c = buildCompactor({ summarize: async () => "s", thresholdTokens: 1 })
  const out = await c.maybeCompact(simple, 9999)
  expect(out.some((m) => m.role === "tool")).toBe(false)
  expect(out[out.length - 1]).toEqual({ role: "user", content: "what's the weather" })
})

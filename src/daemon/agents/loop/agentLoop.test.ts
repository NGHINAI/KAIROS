// src/daemon/agents/loop/agentLoop.test.ts
import { test, expect } from "bun:test"
import { runAgentLoop } from "./agentLoop"
import type { LoopEvent, LoopMsg } from "./types"
import type { StreamEvent } from "../../wrapApi/adapters/openRouterAdapter"
import type { ToolDef } from "../types"

const tools: ToolDef[] = [
  { name: "echo", description: "echo", parameters: {}, execute: async (a: any) => ({ echoed: a }) },
  { name: "boom", description: "boom", parameters: {}, execute: async () => { throw new Error("kaboom") } },
]

/** Fake streaming LLM: yields a scripted list of StreamEvents per turn, and
 *  records the messages it was called with each turn (to assert tool results
 *  were fed back). */
function fakeLlm(turns: StreamEvent[][]) {
  const seen: LoopMsg[][] = []
  let i = 0
  return {
    seen,
    async *stream(body: any): AsyncGenerator<StreamEvent, void, unknown> {
      seen.push(JSON.parse(JSON.stringify(body.messages)))
      const t = turns[Math.min(i, turns.length - 1)]!
      i++
      for (const ev of t) yield ev
    },
  }
}

const done = (text = ""): StreamEvent => ({ kind: "done", text })
const delta = (text: string): StreamEvent => ({ kind: "delta", text })
const toolUse = (id: string, name: string, args = "{}"): StreamEvent => ({ kind: "tool_use", id, name, args_json: args })

test("executes a tool then returns the model's final answer", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo", '{"x":1}'), done()], [delta("All done."), done()]])
  const res = await runAgentLoop([{ role: "user", content: "echo x" }], { llm: llm as any, tools })
  expect(res.finalText).toBe("All done.")
  expect(res.stopped).toBe("final")
  expect(res.toolCalls.map((c) => c.name)).toEqual(["echo"])
  expect(res.turns).toBe(2)
})

test("R4: emits plan_update + returns res.plan when update_plan is called", async () => {
  const { buildUpdatePlanTool } = await import("./updatePlanTool")
  const planJson = JSON.stringify({ plan: [{ step: "do thing", status: "in_progress" }] })
  const llm = fakeLlm([[toolUse("c1", "update_plan", planJson), done()], [delta("done."), done()]])
  const events: LoopEvent[] = []
  const res = await runAgentLoop([{ role: "user", content: "x" }], {
    llm: llm as any,
    tools: [...tools, buildUpdatePlanTool({})],
    onEvent: (e) => events.push(e),
  })
  const pu = events.find((e) => e.kind === "plan_update") as any
  expect(pu).toBeDefined()
  expect(pu.plan[0].step).toBe("do thing")
  expect(res.plan?.[0]?.status).toBe("in_progress") // surfaced for trajectory
})

test("R6: a repeated identical tool round triggers a stall nudge", async () => {
  const echo = toolUse("c", "echo", '{"x":1}')
  const llm = fakeLlm([[echo, done()], [echo, done()], [echo, done()], [delta("ok"), done()]])
  const res = await runAgentLoop([{ role: "user", content: "x" }], { llm: llm as any, tools, stallAfter: 2 })
  const sawStall = llm.seen.some((msgs) => msgs.some((m: any) => m.role === "system" && /same tool call|repeating|change your approach/i.test(m.content ?? "")))
  expect(sawStall).toBe(true)
  expect(res.finalText).toBe("ok")
})

test("feeds the tool RESULT back to the model on the next turn (matching tool_call_id)", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo", '{"x":1}'), done()], [delta("ok"), done()]])
  await runAgentLoop([{ role: "user", content: "echo" }], { llm: llm as any, tools })
  const secondCallMsgs = llm.seen[1]!
  const toolMsg = secondCallMsgs.find((m: any) => m.role === "tool")
  expect(toolMsg).toBeDefined()
  expect((toolMsg as any).tool_call_id).toBe("c1")
  expect(JSON.parse((toolMsg as any).content)).toEqual({ echoed: { x: 1 } })
})

test("tool error is fed back so the model self-corrects (no throw)", async () => {
  const llm = fakeLlm([[toolUse("c1", "boom"), done()], [delta("Couldn't do that, but here's an alternative."), done()]])
  const res = await runAgentLoop([{ role: "user", content: "boom" }], { llm: llm as any, tools })
  const errMsg = llm.seen[1]!.find((m: any) => m.role === "tool") as any
  expect(errMsg.content).toContain("kaboom")
  expect(res.toolCalls[0]!.error).toContain("kaboom")
  expect(res.finalText).toContain("alternative")
})

test("caps at maxTurns and never loops forever", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo"), done()]]) // always asks for a tool
  const res = await runAgentLoop([{ role: "user", content: "loop" }], { llm: llm as any, tools, maxTurns: 3 })
  expect(res.stopped).toBe("max_turns")
  expect(res.turns).toBe(3)
  expect(res.finalText.trim().length).toBeGreaterThan(0) // never silent
})

test("never returns empty text (guard)", async () => {
  const llm = fakeLlm([[done()]]) // model said nothing, no tool
  const res = await runAgentLoop([{ role: "user", content: "..." }], { llm: llm as any, tools })
  expect(res.finalText.trim().length).toBeGreaterThan(0)
})

test("respects a pre-aborted signal", async () => {
  const ctrl = new AbortController()
  ctrl.abort()
  const llm = fakeLlm([[delta("should not run"), done()]])
  const res = await runAgentLoop([{ role: "user", content: "x" }], { llm: llm as any, tools, signal: ctrl.signal })
  expect(res.stopped).toBe("aborted")
})

const errorEv = (message: string): StreamEvent => ({ kind: "error", message })

test("a stream ERROR does not crash the turn — it retries, then recovers", async () => {
  // turn 1 stream errors; retry of turn 1 succeeds with a final answer.
  const llm = fakeLlm([[errorEv("openrouter 429")], [delta("recovered after a blip"), done()]])
  const res = await runAgentLoop([{ role: "user", content: "hi" }], { llm: llm as any, tools, sleep: async () => {} })
  expect(res.stopped).toBe("final")
  expect(res.finalText).toContain("recovered")
})

test("persistent stream errors return a graceful spoken-safe result (stopped='error'), never throw", async () => {
  const llm = fakeLlm([[errorEv("network down")]]) // always errors
  const res = await runAgentLoop([{ role: "user", content: "hi" }], { llm: llm as any, tools, sleep: async () => {} })
  expect(res.stopped).toBe("error")
  expect(res.finalText.trim().length).toBeGreaterThan(0) // never silent
})

test("assistant tool-call message OMITS empty content (provider compatibility)", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo")], [delta("done"), done()]]) // pure tool call, no text
  await runAgentLoop([{ role: "user", content: "echo" }], { llm: llm as any, tools })
  const assistantMsg = llm.seen[1]!.find((m: any) => m.role === "assistant" && m.tool_calls) as any
  expect(assistantMsg).toBeDefined()
  expect(assistantMsg.content === undefined || !("content" in assistantMsg)).toBe(true)
})

test("runs concurrency-safe tool calls in PARALLEL, unsafe ones serially; results appended in call order", async () => {
  const order: string[] = []
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const mk = (name: string, safe: boolean, delay: number): ToolDef => ({
    name, description: "", parameters: {}, concurrencySafe: safe,
    execute: async () => { order.push(`start:${name}`); await sleep(delay); order.push(`end:${name}`); return name },
  })
  const ptools = [mk("A", true, 40), mk("B", true, 40), mk("C", false, 5)]
  const llm = fakeLlm([
    [toolUse("a", "A"), toolUse("b", "B"), toolUse("c", "C"), done()],
    [delta("done"), done()],
  ])
  const res = await runAgentLoop([{ role: "user", content: "x" }], { llm: llm as any, tools: ptools })
  // A and B (safe) overlap: B starts before A ends.
  expect(order.indexOf("start:B")).toBeLessThan(order.indexOf("end:A"))
  // tool results fed back in original call order (a,b,c) regardless of finish order.
  const toolMsgs = llm.seen[1]!.filter((m: any) => m.role === "tool")
  expect(toolMsgs.length).toBe(3)
  expect(res.toolCalls.map((t) => t.name)).toEqual(["A", "B", "C"])
})

test("compacts on a SIZE ESTIMATE when the provider reports no token usage (prevents context blowup)", async () => {
  const bigTools: ToolDef[] = [{ name: "big", description: "", parameters: {}, execute: async () => "x".repeat(40000) }]
  // done() carries NO tokensIn (like OpenRouter streaming) → must fall back to estimate.
  const llm = fakeLlm([[toolUse("c1", "big"), done()], [delta("ok"), done()]])
  let compactedWith = -1
  await runAgentLoop([{ role: "user", content: "x" }], {
    llm: llm as any,
    tools: bigTools,
    compact: async (m, tokens) => { compactedWith = tokens; return m },
  })
  expect(compactedWith).toBeGreaterThan(0) // estimate kicked in despite tokensIn=0
})

test("injects a re-plan note after consecutive failed tool rounds (reflection)", async () => {
  // boom always fails. Turns 1 & 2 each fail a whole round → after 2, a re-plan
  // system note should be injected before turn 3's model call.
  const llm = fakeLlm([
    [toolUse("c1", "boom"), done()],
    [toolUse("c2", "boom"), done()],
    [delta("I can't do that — here's why."), done()],
  ])
  await runAgentLoop([{ role: "user", content: "x" }], { llm: llm as any, tools, replanAfter: 2 })
  const turn3Msgs = llm.seen[2]!
  const replanNote = turn3Msgs.find((m: any) => m.role === "system" && /step back|different|blocking/i.test(m.content ?? ""))
  expect(replanNote).toBeDefined()
})

test("does NOT inject a re-plan note when tools succeed", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo"), done()], [delta("ok"), done()]])
  await runAgentLoop([{ role: "user", content: "x" }], { llm: llm as any, tools, replanAfter: 1 })
  const lastMsgs = llm.seen[1]!
  expect(lastMsgs.some((m: any) => m.role === "system" && /step back/i.test(m.content ?? ""))).toBe(false)
})

test("emits tool_call_start before tool_call_done, and a final event", async () => {
  const events: LoopEvent[] = []
  const llm = fakeLlm([[toolUse("c1", "echo"), done()], [delta("done"), done()]])
  await runAgentLoop([{ role: "user", content: "echo" }], { llm: llm as any, tools, onEvent: (e) => events.push(e) })
  const kinds = events.map((e) => e.kind)
  expect(kinds.indexOf("tool_call_start")).toBeLessThan(kinds.indexOf("tool_call_done"))
  expect(kinds).toContain("final")
})

test("verify gate: an unsupported claim is REPLACED with the grounded correction (no extra tool round)", async () => {
  const llm = fakeLlm([
    [toolUse("c1", "echo", "{}"), done()],
    [delta("Done. Deleted."), done()],
  ])
  const events: LoopEvent[] = []
  const res = await runAgentLoop([{ role: "user", content: "delete it" }], {
    llm: llm as any,
    tools,
    onEvent: (e) => events.push(e),
    verify: async ({ finalText }) =>
      finalText.includes("Deleted") ? { ok: false, concern: "no delete ran", correction: "I haven't deleted it yet." } : { ok: true },
  })
  expect(res.finalText).toBe("I haven't deleted it yet.") // grounded correction, not the phantom
  expect(res.corrected).toBe(true)
  expect(res.turns).toBe(2) // NO third round — text replacement, not re-execution
  expect(events.some((e) => e.kind === "self_correct")).toBe(true)
})

test("verify gate: a FALSE-POSITIVE verify of a SUCCEEDED write does NOT re-execute it (no double-send)", async () => {
  // V1 regression: the old design told the model to 'CALL the tool to do it now',
  // which re-sent an email/charge that had already succeeded. Must never re-execute.
  let sendCount = 0
  const sendTool: ToolDef = { name: "send_email", description: "send", parameters: {}, execute: async () => { sendCount++; return { id: "m" + sendCount } } }
  const llm = fakeLlm([
    [toolUse("c1", "send_email", "{}"), done()],   // sends (succeeds)
    [delta("Sent your email!"), done()],            // claims success
    [toolUse("c2", "send_email", "{}"), done()],    // MUST NEVER be reached
  ])
  const res = await runAgentLoop([{ role: "user", content: "email Sam" }], {
    llm: llm as any,
    tools: [sendTool],
    verify: async () => ({ ok: false, concern: "couldn't confirm", correction: "I've sent your email." }),
  })
  expect(sendCount).toBe(1) // sent exactly once — no double-send
  expect(res.finalText).toBe("I've sent your email.")
  expect(res.corrected).toBe(true)
})

test("verify gate: runs on the FINAL forced-answer turn (turn == maxTurns), the riskiest one", async () => {
  // V3 regression: verify used to be skipped when turn == maxTurns.
  let verified = false
  const llm = fakeLlm([
    [toolUse("c1", "echo", "{}"), done()],          // turn 1 tool round
    [delta("Done. Deleted everything."), done()],   // turn 2 == maxTurns: forced answer
  ])
  const res = await runAgentLoop([{ role: "user", content: "delete" }], {
    llm: llm as any,
    tools,
    maxTurns: 2,
    verify: async () => { verified = true; return { ok: false, concern: "no delete ran", correction: "I haven't deleted anything." } },
  })
  expect(verified).toBe(true) // verify WAS consulted on the last turn
  expect(res.finalText).toBe("I haven't deleted anything.") // and the phantom claim was replaced
})

test("verify gate: a flag with NO correction string → honest hedge, never the rejected claim", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo", "{}"), done()], [delta("Done. Deleted."), done()]])
  const res = await runAgentLoop([{ role: "user", content: "delete it" }], {
    llm: llm as any,
    tools,
    verify: async () => ({ ok: false, concern: "no delete ran" }), // flagged, but no correction provided
  })
  expect(res.finalText).not.toContain("Deleted") // never re-speaks the rejected claim
  expect(res.finalText).toMatch(/double-check|not.*certain/i)
})

test("verify gate: a grounded claim passes through untouched", async () => {
  const llm = fakeLlm([[toolUse("c1", "echo", "{}"), done()], [delta("All set."), done()]])
  let verifyCalls = 0
  const res = await runAgentLoop([{ role: "user", content: "do it" }], {
    llm: llm as any,
    tools,
    verify: async () => { verifyCalls++; return { ok: true } },
  })
  expect(res.finalText).toBe("All set.")
  expect(res.corrected).toBeFalsy()
  expect(res.turns).toBe(2)
  expect(verifyCalls).toBe(1)
})

test("verify gate: NOT consulted on a pure-chat turn (no tools ran)", async () => {
  const llm = fakeLlm([[delta("hey there"), done()]])
  let verifyCalls = 0
  const res = await runAgentLoop([{ role: "user", content: "hi" }], {
    llm: llm as any,
    tools,
    verify: async () => { verifyCalls++; return { ok: false } },
  })
  expect(res.finalText).toBe("hey there")
  expect(verifyCalls).toBe(0) // nothing was done → nothing to ground
})

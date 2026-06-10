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

test("verify gate IS consulted on a zero-tool turn (catches promise-finals where nothing ran)", async () => {
  // The verifier's deterministic promissory check is the reason: "I'm going to create it…"
  // with zero tool calls must trigger a self-correct round. A verify that returns ok keeps
  // pure chat ("hey there") flowing through untouched.
  const llm = fakeLlm([[delta("hey there"), done()]])
  let seenToolCalls: any = null
  const res = await runAgentLoop([{ role: "user", content: "hi" }], {
    llm: llm as any,
    tools,
    verify: async (o) => { seenToolCalls = o.toolCalls; return { ok: true } },
  })
  expect(res.finalText).toBe("hey there")
  expect(seenToolCalls).toEqual([])   // consulted, with an empty ledger
})

test("bad-slug failure → model tries to give up → loop FORCES the search_tools recovery", async () => {
  // turn1: guessed slug fails · turn2: model tries to quit → nudge · turn3: search_tools · turn4: real answer
  const llm = fakeLlm([
    [toolUse("c1", "execute_tool", '{"tool_name":"NOTION_GET_PAGE_CONTENT"}'), done()],
    [delta("I couldn't get the page content."), done()],
    [toolUse("c2", "search_tools", '{"query":"notion read page content"}'), done()],
    [delta("The page covers the Q3 launch plan."), done()],
  ])
  const tools: any[] = [
    { name: "execute_tool", description: "", parameters: {}, execute: async () => { throw new Error("Unable to retrieve tool with slug NOTION_GET_PAGE_CONTENT") } },
    { name: "search_tools", description: "", parameters: {}, execute: async () => ({ tools: [{ name: "NOTION_FETCH_BLOCK_CONTENTS" }] }) },
  ]
  const res = await runAgentLoop([{ role: "user", content: "what's in the page?" }], { llm: llm as any, tools })
  expect(res.toolCalls.some((c) => c.name === "search_tools")).toBe(true)   // recovery forced
  expect(res.finalText).toBe("The page covers the Q3 launch plan.")          // real answer, not the give-up
})

test("the nudge NEVER fires if a successful write already ran (no re-execution risk)", async () => {
  const llm = fakeLlm([
    [toolUse("c1", "execute_tool", '{"tool_name":"GMAIL_SEND_EMAIL","args":{}}'), done()],
    [toolUse("c2", "execute_tool", '{"tool_name":"NOTION_BAD_SLUG"}'), done()],
    [delta("Sent the email, but couldn't update Notion."), done()],
  ])
  const tools: any[] = [{
    name: "execute_tool", description: "", parameters: {},
    execute: async (a: any) => {
      if (a.tool_name === "GMAIL_SEND_EMAIL") return { successful: true, data: { id: "m1" } }
      throw new Error("Unable to retrieve tool with slug NOTION_BAD_SLUG")
    },
  }]
  const { setToolNature } = await import("./verifier")
  setToolNature(new Map([["GMAIL_SEND_EMAIL", "write"]]))
  try {
    const res = await runAgentLoop([{ role: "user", content: "send + update" }], { llm: llm as any, tools })
    expect(res.finalText).toContain("Sent the email")   // accepted as-is — no forced extra rounds after a write
  } finally { setToolNature(null) }
})

test("bad-ARG failure (envelope error, ok call) also forces a recovery round", async () => {
  // execute_tool SUCCEEDS as a call but the result envelope carries the API error
  // ("Invalid page_id format") — the model tries to quit → forced recovery → answers.
  const llm = fakeLlm([
    [toolUse("c1", "execute_tool", '{"tool_name":"NOTION_GET_PAGE_MARKDOWN","args":{"page_id":"CERTUS-AI"}}'), done()],
    [delta("I'm having trouble retrieving the page."), done()],
    [toolUse("c2", "execute_tool", '{"tool_name":"NOTION_SEARCH_NOTION_PAGE","args":{"query":"CERTUS-AI"}}'), done()],
    [delta("The page covers the launch plan."), done()],
  ])
  let calls = 0
  const tools: any[] = [{
    name: "execute_tool", description: "", parameters: {},
    execute: async () => {
      calls++
      if (calls === 1) return { data: { message: "Invalid page_id format: must be a valid UUID" }, error: "Invalid page_id format", successful: false }
      return { successful: true, data: { results: [{ id: "225dcd3a-b64b-80ce-b7c5-c742a80d80b8", title: "CERTUS-AI" }] } }
    },
  }]
  const res = await runAgentLoop([{ role: "user", content: "what's in the page?" }], { llm: llm as any, tools })
  expect(calls).toBe(2)                                          // the recovery actually ran
  expect(res.finalText).toBe("The page covers the launch plan.") // real answer, not the give-up
})

test("claimed INABILITY with zero attempts this turn is rejected — forced to actually try", async () => {
  const llm = fakeLlm([
    [delta("I'm having trouble retrieving that page — the tool needs a specific format."), done()],  // gives up from memory
    [toolUse("c1", "execute_tool", '{"tool_name":"NOTION_SEARCH_NOTION_PAGE","args":{"query":"CERTUS-AI"}}'), done()],
    [delta("Found it — the page lists the launch checklist."), done()],
  ])
  const tools: any[] = [{ name: "execute_tool", description: "", parameters: {}, execute: async () => ({ successful: true, data: { results: [{ id: "u1", title: "CERTUS-AI" }] } }) }]
  const res = await runAgentLoop([{ role: "user", content: "what's in the CERTUS-AI page?" }], { llm: llm as any, tools })
  expect(res.toolCalls.length).toBe(1)                                  // it was made to try
  expect(res.finalText).toBe("Found it — the page lists the launch checklist.")
})

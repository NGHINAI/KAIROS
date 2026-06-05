import { test, expect, mock } from "bun:test"
import { Conductor } from "./conductor"

test("Conductor routes fast intents through Tier 1 only", async () => {
  const events: any[] = []
  const fakeLlm = { complete: mock(async () => ({ text: JSON.stringify({ tier: "fast", reason: "chat", confidence: 0.9 }) })) }
  const fastReply = { complete: mock(async () => ({ text: "Hi there." })) }

  const conductor = new Conductor({
    classifyLlm: fakeLlm as any,
    fastLlm: fastReply as any,
    smartLlm: { complete: mock(async () => { throw new Error("smart should not be called") }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e) => events.push(e),
  })

  await conductor.handle({ conversationId: "test", utterance: "hi" })
  const kinds = events.map((e) => e.kind)
  expect(kinds).toContain("agent_intent")
  expect(kinds).toContain("agent_done")
})

test("Conductor calls trajWriter.append after each turn", async () => {
  const trajCalls: any[] = []
  const conductor = new Conductor({
    classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier: "fast", reason: "chat", confidence: 0.9 }) }) } as any,
    fastLlm: { complete: async () => ({ text: "ok" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: () => {},
    trajWriter: { append: async (entry: any) => { trajCalls.push(entry) } } as any,
  })
  await conductor.handle({ conversationId: "test", utterance: "hello" })
  expect(trajCalls.length).toBe(1)
  expect(trajCalls[0].user_input).toBe("hello")
  expect(trajCalls[0].intent_tier).toBe("fast")
})

test("Conductor smart-path: emits agent_activity (lane A tree) + agent_delta/agent_plan/agent_status", async () => {
  const events: any[] = []
  const fakeRunPlanner = async (_input: string, opts: any) => {
    opts.onEvent?.({ kind: "tool_call_start", id: "c1", name: "GMAIL_FETCH_EMAILS", args: {} })
    opts.onEvent?.({ kind: "tool_call_done", id: "c1", name: "GMAIL_FETCH_EMAILS", result: { count: 3 } })
    opts.onEvent?.({ kind: "assistant_delta", text: "You've got " })
    opts.onEvent?.({ kind: "plan_update", plan: [{ step: "check mail", status: "completed" }, { step: "summarize", status: "in_progress" }] })
    return { finalOutput: "You've got 3.", toolCalls: [] }
  }
  const conductor = new Conductor({
    classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier: "smart", reason: "x", confidence: 0.9 }) }) } as any,
    fastLlm: { complete: async () => ({ text: "" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e: any) => events.push(e),
    runPlanner: fakeRunPlanner,
    speakBackend: { speak: async () => {} } as any,
  })
  await conductor.handle({ conversationId: "test", utterance: "summarize", runId: "turn1" })
  const acts = events.filter((e) => e.kind === "agent_activity").map((e) => e.activity)
  expect(acts.some((a) => a.lane === "A" && a.runId === "turn1" && a.parentRunId === null && a.kind === "planning")).toBe(true)
  expect(acts.some((a) => a.kind === "tool_call" && a.tool === "GMAIL_FETCH_EMAILS")).toBe(true)
  expect(acts.some((a) => a.kind === "tool_done")).toBe(true)
  expect(events.some((e) => e.kind === "agent_delta" && e.text === "You've got ")).toBe(true)
  expect(events.some((e) => e.kind === "agent_plan")).toBe(true)
  expect(events.some((e) => e.kind === "agent_status" && /working on/i.test(e.text))).toBe(true)
})

test("Conductor smart-path: a self_correct loop event surfaces as a caption + activity-tree node", async () => {
  const events: any[] = []
  const fakeRunPlanner = async (_input: string, opts: any) => {
    opts.onEvent?.({ kind: "self_correct", concern: "no delete tool ran" })
    return { finalOutput: "Actually, I haven't deleted it yet.", corrected: true, toolCalls: [] }
  }
  const conductor = new Conductor({
    classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier: "smart", reason: "x", confidence: 0.9 }) }) } as any,
    fastLlm: { complete: async () => ({ text: "" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e: any) => events.push(e),
    runPlanner: fakeRunPlanner,
    speakBackend: { speak: async () => {} } as any,
  })
  await conductor.handle({ conversationId: "test", utterance: "delete it", runId: "turnSC" })
  // live caption for the HUD ("double-check…")
  expect(events.some((e) => e.kind === "agent_status" && /double-check/i.test(e.text))).toBe(true)
  // structured node on the Lane A activity tree, carrying the concern
  const acts = events.filter((e) => e.kind === "agent_activity").map((e) => e.activity)
  expect(acts.some((a) => a.kind === "self_correct" && a.lane === "A" && a.summary === "no delete tool ran")).toBe(true)
})

test("Conductor smart-path: emits agent_planning + agent_done", async () => {
  const events: any[] = []

  const fakeRunPlanner = async (_input: string, _opts: any) => ({
    finalOutput: "Done — found 5 items.",
    toolCalls: [{ id: "t1", name: "gmail_list", args: { since: "today" }, result: { count: 5 } }],
  })

  const conductor = new Conductor({
    classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier: "smart", reason: "multi-step", confidence: 0.9 }) }) } as any,
    fastLlm: { complete: async () => ({ text: "Checking..." }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [{ name: "gmail_list", description: "", parameters: {}, execute: async () => ({ count: 5 }) }],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e: any) => events.push(e),
    runPlanner: fakeRunPlanner,
    speakBackend: { speak: async () => {} } as any,
  })
  await conductor.handle({ conversationId: "test", utterance: "summarize my emails" })

  const kinds = events.map((e) => e.kind)
  expect(kinds).toContain("agent_planning")
  expect(kinds).toContain("agent_done")
})

test("Conductor fast-path never emits a silent empty reply (reasoning-model footgun guard)", async () => {
  const events: any[] = []
  const conductor = new Conductor({
    classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier: "fast", reason: "chat", confidence: 0.9 }) }) } as any,
    // gpt-oss/nemotron-style reasoning model: budget consumed reasoning, content empty.
    fastLlm: { complete: async () => ({ text: "" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e: any) => events.push(e),
  })
  await conductor.handle({ conversationId: "test", utterance: "can you connect me to linear?" })
  const done = events.find((e) => e.kind === "agent_done")
  expect(done).toBeDefined()
  expect(done.text.trim().length).toBeGreaterThan(0)
})

test("Conductor never speaks raw tool-call markup if the model leaks it (smart path)", async () => {
  const events: any[] = []
  const spoken: string[] = []
  const leak = '<tool_call_begin>functions.execute_tool {"tool_name":"GMAIL_LIST_MESSAGES","args":{"max_results":5}}<tool_call_end><tool_calls_section_end>'
  const conductor = new Conductor({
    classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier: "smart", reason: "x", confidence: 0.9 }) }) } as any,
    fastLlm: { complete: async () => ({ text: "" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e: any) => events.push(e),
    runPlanner: async () => ({ finalOutput: leak, toolCalls: [] }),
    speakBackend: { speak: async (t: string) => { spoken.push(t) } } as any,
  })
  await conductor.handle({ conversationId: "t", utterance: "latest email?" })
  const done = events.find((e) => e.kind === "agent_done")
  expect(done.text).not.toMatch(/<tool_call|tool_calls_section|functions\./)  // markup never surfaces
  expect(done.text.trim().length).toBeGreaterThan(0)                          // says something instead
  expect(spoken.join(" ")).not.toMatch(/<tool_call|functions\./)              // and never spoken
})

test("Conductor feeds recent conversation to the router so short replies resolve in context", async () => {
  let classifyMsgs = ""
  const conductor = new Conductor({
    classifyLlm: { complete: async (b: any) => { classifyMsgs = JSON.stringify(b.messages); return { text: JSON.stringify({ tier: "fast", reason: "x", confidence: 0.9 }) } } } as any,
    fastLlm: { complete: async () => ({ text: "ok" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: () => {},
    conversationStore: { recentTurns: async () => [{ role: "agent", text: "The delete failed — want me to retry?" }, { role: "user", text: "Yes" }] } as any,
  })
  await conductor.handle({ conversationId: "t", utterance: "Yes" })
  expect(classifyMsgs).toContain("delete failed")  // router saw the prior turn
})

test("Conductor routes deep + vision through the tool-capable smart path (not tool-less fast)", async () => {
  for (const tier of ["deep", "vision"]) {
    const events: any[] = []
    let plannerCalled = false
    const conductor = new Conductor({
      classifyLlm: { complete: async () => ({ text: JSON.stringify({ tier, reason: "x", confidence: 0.9 }) }) } as any,
      fastLlm: { complete: async () => ({ text: "fast-should-not-run" }) } as any,
      smartLlm: { complete: async () => ({ text: "" }) } as any,
      tools: [],
      contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
      onEvent: (e: any) => events.push(e),
      runPlanner: async () => { plannerCalled = true; return { finalOutput: "done", toolCalls: [] } },
      speakBackend: { speak: async () => {} } as any,
    })
    await conductor.handle({ conversationId: "t", utterance: "what's on my screen?" })
    expect(plannerCalled).toBe(true)  // went through the planner, not handleFast
  }
})

test("Conductor.handle respects abort signal mid-execution", async () => {
  const events: any[] = []
  const ctrl = new AbortController()
  const conductor = new Conductor({
    classifyLlm: { complete: async () => {
      await new Promise((r) => setTimeout(r, 50))
      return { text: JSON.stringify({ tier: "fast", reason: "chat", confidence: 0.9 }) }
    }} as any,
    fastLlm: { complete: async () => ({ text: "ok" }) } as any,
    smartLlm: { complete: async () => ({ text: "" }) } as any,
    tools: [],
    contextBuilder: { build: async () => ({ system: "", tools: [] }) } as any,
    onEvent: (e) => events.push(e),
  })
  const p = conductor.handle({ conversationId: "test", utterance: "hi", signal: ctrl.signal })
  setTimeout(() => ctrl.abort(), 20)
  await p
  expect(events.some((e) => e.kind === "agent_interrupted")).toBe(true)
})

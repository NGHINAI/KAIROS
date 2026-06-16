// Fast-front collapse: every turn hits the FAST model first (with recent context). It either
// answers directly (chit-chat) or routes via a directive on its first line:
//   [[task]]  → the smart planner (tools), this turn       [[think]] → deep model, sync, time-capped
// The pre-classifier is OUT of the hot path (KAIROS_CLASSIC_ROUTER=1 restores it).

import { test, expect } from "bun:test"
import { Conductor } from "./conductor"

function makeConductor(over: Partial<ConstructorParameters<typeof Conductor>[0]> & Record<string, any> = {}) {
  const events: any[] = []
  const spoken: string[] = []
  const deps: any = {
    classifyLlm: { complete: async () => { throw new Error("classifier must NOT be called in fast-front mode") } },
    fastLlm: { complete: async () => ({ text: "Hey! What's up?" }) },
    smartLlm: { complete: async () => ({ text: "" }) },
    tools: [],
    contextBuilder: { build: async ({ tier }: any) => ({ system: `sys-${tier}`, tools: [] }) },
    onEvent: (e: any) => events.push(e),
    speakBackend: { speak: async (t: string) => { spoken.push(t) } },
    ...over,
  }
  return { conductor: new Conductor(deps), events, spoken, deps }
}

test("chit-chat: front answers directly — NO classifier call, reply spoken, tier=fast", async () => {
  const { conductor, events, spoken } = makeConductor()
  await conductor.handle({ conversationId: "c", utterance: "hey, how's it going?" })
  expect(events.find((e) => e.kind === "agent_done")?.text).toBe("Hey! What's up?")
  expect(events.find((e) => e.kind === "agent_intent")?.tier).toBe("fast")
  expect(spoken).toContain("Hey! What's up?")
})

test("[[task]] routes to the smart planner with a SMART context; say-line spoken first", async () => {
  const plannerInputs: any[] = []
  const { conductor, events, spoken } = makeConductor({
    fastLlm: { complete: async () => ({ text: "[[task]] on it — checking now." }) },
    runPlanner: async (input: string, opts: any) => {
      plannerInputs.push({ input, instructions: opts.instructions })
      return { finalOutput: "You have 3 emails.", toolCalls: [] }
    },
  })
  await conductor.handle({ conversationId: "c", utterance: "check my email" })
  expect(plannerInputs.length).toBe(1)
  expect(plannerInputs[0].input).toBe("check my email")
  expect(plannerInputs[0].instructions).toBe("sys-smart")          // planner gets the SMART prompt
  expect(events.find((e) => e.kind === "agent_intent")?.tier).toBe("smart")
  expect(spoken[0]).toBe("on it — checking now.")                  // interim spoken BEFORE the answer
  expect(spoken).toContain("You have 3 emails.")
})

test("[[think]] runs the deep think LLM synchronously and speaks its answer; tier=deep", async () => {
  const { conductor, events, spoken } = makeConductor({
    fastLlm: { complete: async () => ({ text: "[[think]] good question — let me think." }) },
    thinkLlm: { complete: async () => ({ text: "After weighing both, option B is better because it compounds." }) },
    runPlanner: async () => { throw new Error("planner must not run for think") },
  })
  await conductor.handle({ conversationId: "c", utterance: "which option is better, A or B?" })
  expect(events.find((e) => e.kind === "agent_intent")?.tier).toBe("deep")
  expect(spoken[0]).toBe("good question — let me think.")
  const done = events.find((e) => e.kind === "agent_done")
  expect(done?.text).toContain("option B")
  expect(spoken.some((s) => s.includes("option B"))).toBe(true)
})

test("[[think]] that exceeds the time cap converts to a background task + commit phrase", async () => {
  const spawned: any[] = []
  process.env.KAIROS_THINK_TIMEOUT_MS = "30"
  try {
    const { conductor, events, spoken } = makeConductor({
      fastLlm: { complete: async () => ({ text: "[[think]]" }) },
      thinkLlm: { complete: () => new Promise(() => {}) },         // hangs forever
      contextBuilder: { build: async ({ tier }: any) => ({
        system: `sys-${tier}`,
        tools: [{ name: "spawn_background_task", description: "", parameters: {}, execute: async (a: any) => { spawned.push(a); return "Started in the background" } }],
      }) },
    })
    await conductor.handle({ conversationId: "c", utterance: "really hard question" })
    expect(spawned.length).toBe(1)
    expect(spawned[0].goal).toContain("really hard question")
    const done = events.find((e) => e.kind === "agent_done")
    expect(done?.text.toLowerCase()).toMatch(/get back to you|taking me a moment/)
    expect(spoken.some((s) => /get back to you|taking me a moment/i.test(s))).toBe(true)
  } finally { delete process.env.KAIROS_THINK_TIMEOUT_MS }
})

test("[[think]] without a thinkLlm falls back to the planner (graceful)", async () => {
  let plannerRan = false
  const { conductor } = makeConductor({
    fastLlm: { complete: async () => ({ text: "[[think]]" }) },
    runPlanner: async () => { plannerRan = true; return { finalOutput: "ok", toolCalls: [] } },
  })
  await conductor.handle({ conversationId: "c", utterance: "hard q" })
  expect(plannerRan).toBe(true)
})

test("recent turns are given to the front so follow-ups ('yes') route correctly", async () => {
  const bodies: any[] = []
  const { conductor } = makeConductor({
    fastLlm: { complete: async (body: any) => { bodies.push(body); return { text: "[[task]]" } } },
    conversationStore: { recentTurns: async () => [
      { role: "agent", text: "Should I send the email to Sam?" },
      { role: "user", text: "yes" },
    ] },
    runPlanner: async () => ({ finalOutput: "Sent.", toolCalls: [] }),
  })
  await conductor.handle({ conversationId: "c", utterance: "yes, send it" })
  const msgs = bodies[0].messages
  expect(msgs.some((m: any) => m.role === "assistant" && /send the email to Sam/.test(m.content))).toBe(true)
  expect(msgs[msgs.length - 1]).toEqual({ role: "user", content: "yes, send it" })
})

test("empty front reply never goes silent (fallback line)", async () => {
  const { conductor, events } = makeConductor({ fastLlm: { complete: async () => ({ text: "" }) } })
  await conductor.handle({ conversationId: "c", utterance: "ok" })
  expect(events.find((e) => e.kind === "agent_done")?.text).toMatch(/didn't catch/i)
})

test("KAIROS_CLASSIC_ROUTER=1 restores the old classifier path", async () => {
  process.env.KAIROS_CLASSIC_ROUTER = "1"
  try {
    let classified = false
    const { conductor, events } = makeConductor({
      classifyLlm: { complete: async () => { classified = true; return { text: JSON.stringify({ tier: "fast", reason: "chat", confidence: 0.9 }) } } },
      fastLlm: { complete: async () => ({ text: "hi" }) },
    })
    await conductor.handle({ conversationId: "c", utterance: "hello" })
    expect(classified).toBe(true)
    expect(events.find((e) => e.kind === "agent_done")?.text).toBe("hi")
  } finally { delete process.env.KAIROS_CLASSIC_ROUTER }
})

test("a directive ANYWHERE except the start is treated as plain text (never spoken as markup)", async () => {
  const { conductor, events } = makeConductor({
    fastLlm: { complete: async () => ({ text: "Sure thing [[task]]" }) },   // malformed placement
  })
  await conductor.handle({ conversationId: "c", utterance: "thanks" })
  const done = events.find((e) => e.kind === "agent_done")
  expect(done?.text).not.toContain("[[")                            // directive scrubbed from speech
})

test("guidance is STICKY: a follow-up after a guide turn stays in-house (lane=guidance)", async () => {
  const lanes: string[] = []
  const { conductor } = makeConductor({
    fastLlm: { complete: async () => ({ text: "[[task]] one sec" }) },
    runPlanner: async (_input: string, opts: any) => {
      lanes.push(opts.lane)
      return { finalOutput: "ok", toolCalls: [{ id: "1", name: "read_screen", args: {} }] }
    },
  })
  await conductor.handle({ conversationId: "c", utterance: "show me where the sound settings are" })
  await conductor.handle({ conversationId: "c", utterance: "continue" })   // misses the regex
  expect(lanes[0]).toBe("guidance")   // GUIDE_RE hit
  expect(lanes[1]).toBe("guidance")   // STICKY — not bounced to the (broken) opencode lane
})

test("a plain general task is NOT made sticky-guidance", async () => {
  const lanes: string[] = []
  const { conductor } = makeConductor({
    fastLlm: { complete: async () => ({ text: "[[task]] sure" }) },
    runPlanner: async (_i: string, opts: any) => { lanes.push(opts.lane); return { finalOutput: "done", toolCalls: [] } },
  })
  await conductor.handle({ conversationId: "c", utterance: "add milk to my shopping list" })
  await conductor.handle({ conversationId: "c", utterance: "also add eggs" })
  expect(lanes[0]).toBe("general")
  expect(lanes[1]).toBe("general")
})

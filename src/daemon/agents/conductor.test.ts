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

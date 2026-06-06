import { test, expect, mock } from "bun:test"
import { classifyIntent } from "./intentClassifier"

test("classifyIntent returns 'fast' for simple chat", async () => {
  const fakeLlm = {
    complete: mock(async () => ({ text: JSON.stringify({ tier: "fast", reason: "chat", confidence: 0.9 }) })),
  }
  const result = await classifyIntent("Hello there!", { llm: fakeLlm as any })
  expect(result.tier).toBe("fast")
})

test("classifyIntent returns 'smart' for multi-step intent", async () => {
  const fakeLlm = {
    complete: mock(async () => ({ text: JSON.stringify({ tier: "smart", reason: "multi-step plan", confidence: 0.8 }) })),
  }
  const result = await classifyIntent("Pull WhatsApp chats, extract meetings, add them to my calendar", { llm: fakeLlm as any })
  expect(result.tier).toBe("smart")
})

test("classifyIntent returns 'vision' for screen intents", async () => {
  const fakeLlm = {
    complete: mock(async () => ({ text: JSON.stringify({ tier: "vision", reason: "screen request", confidence: 0.95 }) })),
  }
  const result = await classifyIntent("Show me where to click", { llm: fakeLlm as any })
  expect(result.tier).toBe("vision")
})

test("classifyIntent passes recent conversation context to the router (so 'Yes' routes correctly)", async () => {
  let seen = ""
  const fakeLlm = {
    complete: mock(async (body: any) => { seen = JSON.stringify(body.messages); return { text: JSON.stringify({ tier: "smart", reason: "confirming retry", confidence: 0.9 }) } }),
  }
  await classifyIntent("Yes.", { llm: fakeLlm as any, recentContext: "KAIROS: The delete failed — want me to retry?\nuser: Yes." })
  expect(seen).toContain("delete failed")  // the router actually sees the prior turn
})

test("classifyIntent strips markdown code fences before parsing JSON", async () => {
  const fakeLlm = { complete: mock(async () => ({ text: '```json\n{"tier":"smart","reason":"x","confidence":0.8}\n```' })) }
  const r = await classifyIntent("do it", { llm: fakeLlm as any })
  expect(r.tier).toBe("smart")
})

test("classifyIntent falls back to 'fast' on malformed LLM output", async () => {
  const fakeLlm = {
    complete: mock(async () => ({ text: "not json" })),
  }
  const result = await classifyIntent("...", { llm: fakeLlm as any })
  expect(result.tier).toBe("fast")
  expect(result.confidence).toBeLessThan(0.5)
})

import { test, expect, mock } from "bun:test"
import { generateAck, generateTransition, generateFiller } from "./executorAgent"

test("generateAck returns a short ack phrase for a tool call", async () => {
  const fakeLlm = { complete: mock(async () => ({ text: "Checking your calendar." })) }
  const ack = await generateAck("google_calendar.list_events", { llm: fakeLlm as any })
  expect(ack.length).toBeGreaterThan(0)
  expect(ack.length).toBeLessThan(80)
})

test("generateTransition summarizes a tool result", async () => {
  const fakeLlm = { complete: mock(async () => ({ text: "Found 3 events." })) }
  const out = await generateTransition("google_calendar.list_events", { count: 3 }, { llm: fakeLlm as any })
  expect(out).toContain("3")
})

test("generateFiller emits a 'still working' phrase", async () => {
  const fakeLlm = { complete: mock(async () => ({ text: "Still working on it." })) }
  const out = await generateFiller({ llm: fakeLlm as any })
  expect(out.length).toBeGreaterThan(0)
})

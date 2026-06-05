// src/daemon/agents/turnLogger.test.ts
import { test, expect } from "bun:test"
import { TurnLogger } from "./turnLogger"

function mk() {
  const lines: string[] = []
  const jsonl: any[] = []
  const logger = new TurnLogger({
    appendLine: (l) => lines.push(l),
    appendJsonl: (o) => jsonl.push(o),
    now: () => 1_700_000_000_000,
  })
  return { logger, lines, jsonl }
}

test("records a turn to both the human log and the JSONL machine log", () => {
  const { logger, lines, jsonl } = mk()
  logger.record({
    at: 1_700_000_000_000, conversationId: "conv_default", utterance: "what are my linear issues?",
    tier: "smart",
    toolCalls: [{ name: "search_tools", args: { query: "linear issues" } }, { name: "execute_tool", args: { tool_name: "LINEAR_LIST_ISSUES" }, result: "3 issues" }],
    reply: "You've got three open issues.",
  })
  expect(jsonl.length).toBe(1)
  expect(jsonl[0].utterance).toBe("what are my linear issues?")
  expect(jsonl[0].toolCalls.length).toBe(2)
  const human = lines.join("\n")
  expect(human).toContain("USER: what are my linear issues?")
  expect(human).toContain("LINEAR_LIST_ISSUES")
  expect(human).toContain("KAIROS: You've got three open issues.")
})

test("flags a tool-call LEAK when the reply contains raw tool-call markup", () => {
  const { logger, lines, jsonl } = mk()
  logger.record({
    at: 1_700_000_000_000, conversationId: "c", utterance: "latest email?", tier: "smart",
    toolCalls: [],  // nothing executed
    reply: '<tool_call_begin>functions.execute_tool {"tool_name":"GMAIL_LIST_MESSAGES","args":{"max_results":5}}<tool_call_end><tool_calls_section_end>',
  })
  expect(jsonl[0].leaked).toBe(true)
  expect(lines.join("\n")).toMatch(/LEAK/i)
})

test("does NOT flag a leak for normal prose replies", () => {
  const { logger, jsonl } = mk()
  logger.record({ at: 1, conversationId: "c", utterance: "hi", tier: "fast", toolCalls: [], reply: "Hey! How can I help?" })
  expect(jsonl[0].leaked).toBe(false)
})

test("notes when a smart turn ran with NO tools (possible silent/hallucinated answer)", () => {
  const { logger, lines } = mk()
  logger.record({ at: 1, conversationId: "c", utterance: "latest email?", tier: "smart", toolCalls: [], reply: "Your latest email is from Starbucks." })
  expect(lines.join("\n")).toMatch(/no tools/i)
})

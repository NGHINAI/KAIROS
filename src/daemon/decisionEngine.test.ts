// src/daemon/decisionEngine.test.ts
import { test, expect } from "bun:test"
import { DecisionEngine } from "./decisionEngine"
import { initDatabase } from "./db"

function testDb(): any {
  return initDatabase(":memory:")   // full daemon schema (tasks, ticks, messages, …)
}

const cfg = {
  sandboxDir: process.cwd(),
  budget: { maxSubprocessPerHour: 60, maxProactiveMsgsPerHour: 10, maxCostCentsPerHour: 500 },
  models: { tick: "openai/gpt-4o-mini" },
} as any

test("decide() uses the injected LLM completer (NOT the claude -p subprocess) and parses its decision", async () => {
  const db = testDb()
  let called = false
  const fakeLlm = {
    complete: async (_body: any) => { called = true; return { text: "DECISION: SLEEP 300\nREASONING: nothing to do right now" } },
  }
  const engine = new DecisionEngine(db, cfg, fakeLlm as any)
  const d = await engine.decide({ source: "timer", reason: "test" } as any)
  expect(called).toBe(true)           // proves it called the LLM, not claude
  expect(d.kind).toBe("SLEEP")
  expect((d as any).seconds).toBe(300)
})

test("decide() falls back gracefully (no crash) when the LLM returns empty", async () => {
  const db = testDb()
  const fakeLlm = { complete: async () => ({ text: "" }) }
  const engine = new DecisionEngine(db, cfg, fakeLlm as any)
  const d = await engine.decide({ source: "timer", reason: "test" } as any)
  expect(d.kind).toBeDefined()        // a fallback Decision, not a throw
})

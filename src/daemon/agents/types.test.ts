import { test, expect } from "bun:test"
import type { Tier, IntentDecision, AgentEvent } from "./types"
import { TIER_MODELS } from "./types"

test("TIER_MODELS includes fast / smart / deep / vision", () => {
  expect(TIER_MODELS.fast).toBeDefined()
  expect(TIER_MODELS.smart).toBeDefined()
  expect(TIER_MODELS.deep).toBeDefined()
  expect(TIER_MODELS.vision).toBeDefined()
})

test("IntentDecision has tier + reason + confidence", () => {
  const d: IntentDecision = { tier: "fast", reason: "simple chat", confidence: 0.9 }
  expect(d.tier).toBe("fast")
})

test("AgentEvent has known kinds", () => {
  const e: AgentEvent = { kind: "agent_ack", text: "on it", tier: "fast" }
  expect(e.kind).toBe("agent_ack")
})

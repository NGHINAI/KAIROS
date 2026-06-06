import { test, expect } from "bun:test"
import type { Tier, IntentDecision, AgentEvent } from "./types"
import { TIER_MODELS, verifyModel } from "./types"

// Model-selection should respect the ONE knob the user actually sets
// (KAIROS_SMART_MODEL). The verify gate + vision tier previously hardcoded
// openai/gpt-4o, so they fired GPT requests even when the user ran gemini-only.
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {}
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k] }
  try { fn() } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]! }
  }
}

test("verifyModel falls back to KAIROS_SMART_MODEL when KAIROS_VERIFY_MODEL is unset", () => {
  withEnv({ KAIROS_VERIFY_MODEL: undefined, KAIROS_SMART_MODEL: "google/gemini-2.5-flash" }, () => {
    expect(verifyModel()).toBe("google/gemini-2.5-flash")
  })
})

test("verifyModel uses KAIROS_VERIFY_MODEL when explicitly set", () => {
  withEnv({ KAIROS_VERIFY_MODEL: "openai/gpt-4o", KAIROS_SMART_MODEL: "google/gemini-2.5-flash" }, () => {
    expect(verifyModel()).toBe("openai/gpt-4o")
  })
})

test("verifyModel terminal fallback is openai/gpt-4o when nothing is configured", () => {
  withEnv({ KAIROS_VERIFY_MODEL: undefined, KAIROS_SMART_MODEL: undefined }, () => {
    expect(verifyModel()).toBe("openai/gpt-4o")
  })
})

test("vision tier falls back to KAIROS_SMART_MODEL when KAIROS_VISION_MODEL is unset", () => {
  withEnv({ KAIROS_VISION_MODEL: undefined, KAIROS_SMART_MODEL: "google/gemini-2.5-flash" }, () => {
    expect(TIER_MODELS.vision()).toBe("google/gemini-2.5-flash")
  })
})

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

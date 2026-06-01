// src/daemon/agents/contextBuilder.test.ts
import { test, expect } from "bun:test"
import { ContextBuilder } from "./contextBuilder"

test("ContextBuilder.buildSessionPrefix returns cached blocks once per session", async () => {
  const loaders = {
    soulDigest: async () => "You are KAIROS. Tone: warm.",
    standingOrdersSummary: async () => "No active orders.",
    memoryOverview: async () => "(empty)",
    kairosSkills: async () => [],
    introspectionTools: async () => [],
  }
  const cb = new ContextBuilder({ loaders } as any)
  const a = await cb.buildSessionPrefix()
  const b = await cb.buildSessionPrefix()
  expect(a).toBe(b)  // cached
  expect(a.system).toContain("KAIROS")
})

test("ContextBuilder.buildTurnDelta returns recent conv + memory hits + current utterance", async () => {
  const cb = new ContextBuilder({
    loaders: {
      soulDigest: async () => "",
      standingOrdersSummary: async () => "",
      memoryOverview: async () => "",
      kairosSkills: async () => [],
      introspectionTools: async () => [],
    },
    memoryInjector: { inject: async () => [{ source: "L3", text: "fact about Sarah" } as any] } as any,
    conversationStore: { recentTurns: async () => [{ role: "user", text: "hi", at: 1 }] } as any,
  })
  const delta = await cb.buildTurnDelta({ utterance: "what about Sarah?", conversationId: "test" })
  expect(delta.recentTurns.length).toBe(1)
  expect(delta.memoryHits.length).toBe(1)
})

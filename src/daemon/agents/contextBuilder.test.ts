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

test("ContextBuilder.buildSessionPrefix includes tools from the actionTools loader (so the planner can take actions)", async () => {
  const connectTool = { name: "connect_service", description: "Connect a service", parameters: {}, execute: async () => ({}) }
  const cb = new ContextBuilder({
    loaders: {
      soulDigest: async () => "You are KAIROS.",
      standingOrdersSummary: async () => "",
      memoryOverview: async () => "",
      kairosSkills: async () => [],
      introspectionTools: async () => [],
      actionTools: async () => [connectTool as any],
    },
  } as any)
  const prefix = await cb.buildSessionPrefix()
  expect(prefix.tools.map((t) => t.name)).toContain("connect_service")
})

test("fast-tier prompt is slimmer — keeps talk/persona but omits the acting+tool rules", async () => {
  const cb = new ContextBuilder({
    loaders: { soulDigest: async () => "You are KAIROS.", standingOrdersSummary: async () => "orders here", memoryOverview: async () => "mem", kairosSkills: async () => [], introspectionTools: async () => [] },
  } as any)
  const fast = await cb.build({ utterance: "hi", tier: "fast" })
  const smart = await cb.build({ utterance: "hi", tier: "smart" })
  expect(smart.system).toContain("## How you act")        // smart gets tool/grounding rules
  expect(fast.system).not.toContain("## How you act")     // fast does not (no tools on this turn)
  expect(fast.system).toContain("## How you talk")        // but keeps the voice/persona rules
})

test("Phase 5: both tiers carry the baseline character (warm/witty/concise) + anti-robotic style", async () => {
  const cb = new ContextBuilder({
    loaders: { soulDigest: async () => "You are KAIROS.", standingOrdersSummary: async () => "", memoryOverview: async () => "", kairosSkills: async () => [], introspectionTools: async () => [] },
  } as any)
  const smart = (await cb.build({ utterance: "hi", tier: "smart" })).system.toLowerCase()
  const fast = (await cb.build({ utterance: "hi", tier: "fast" })).system.toLowerCase()
  for (const sys of [smart, fast]) {
    expect(sys).toContain("## your character")
    expect(sys).toMatch(/warm, witty, and concise/)
    expect(sys).toMatch(/be a person, not a service/)
    expect(sys).toMatch(/never sound scripted|never reuse the same canned phrase/) // anti-robotic
    expect(sys).toMatch(/takes precedence/) // soul.md vibe overrides the baseline
  }
})

test("Phase 5: KAIROS_PERSONA_TONE layers a tone hint onto the character", async () => {
  const cb = new ContextBuilder({
    loaders: { soulDigest: async () => "You are KAIROS.", standingOrdersSummary: async () => "", memoryOverview: async () => "", kairosSkills: async () => [], introspectionTools: async () => [] },
    personaTone: "dry and deadpan",
  } as any)
  const s = (await cb.build({ utterance: "hi", tier: "smart" })).system
  expect(s).toContain("dry and deadpan")
})

test("smart prompt includes the grounding rule (call tools for live data, don't answer from memory)", async () => {
  const cb = new ContextBuilder({
    loaders: { soulDigest: async () => "You are KAIROS.", standingOrdersSummary: async () => "", memoryOverview: async () => "", kairosSkills: async () => [], introspectionTools: async () => [] },
  } as any)
  const p = await cb.buildSessionPrefix()
  const s = p.system.toLowerCase()
  expect(s).toMatch(/never answer from memory|fetch it fresh|call the tool/)   // grounding
  expect(s).toMatch(/summari|never enumerate|lead with the count/)             // summarize, don't list IDs
  expect(s).toMatch(/try (a |one )?(different|another)|retry/)                   // tool-failure strategy (recover-then-report)
})

test("smart system prompt carries the production behavioral rules (regression guard)", async () => {
  const cb = new ContextBuilder({
    loaders: {
      soulDigest: async () => "You are KAIROS.",
      standingOrdersSummary: async () => "",
      memoryOverview: async () => "",
      kairosSkills: async () => [],
      introspectionTools: async () => [],
      actionTools: async () => [],
    },
  } as any)
  const { system } = await cb.build({ utterance: "x", tier: "smart" })
  // Voice + behavioral discipline ported from Codex/Claude Code (voice-tuned):
  expect(system).toMatch(/No markdown/i)              // voice formatting
  expect(system).toMatch(/summarize/i)                // human results, not enumeration
  expect(system).toMatch(/exact id|carry/i)           // multi-step chaining
  expect(system).toMatch(/confirm/i)                  // confirm-before-destructive
  expect(system).toMatch(/nothing more/i)             // do-what's-asked (proactiveness balance)
  expect(system).toMatch(/STOP|check with the user/i) // stop-on-unexpected
  expect(system).toMatch(/mirror/i)                   // mirror the user's style
})

test("ContextBuilder injects FRESH liveContext every turn (not cached) so persona adapts within a session", async () => {
  let calls = 0
  const cb = new ContextBuilder({
    loaders: {
      soulDigest: async () => "KAIROS",
      standingOrdersSummary: async () => "",
      memoryOverview: async () => "",
      kairosSkills: async () => [],
      introspectionTools: async () => [],
      liveContext: async () => `hint#${++calls}`,
    },
    conversationStore: { recentTurns: async () => [] } as any,
    memoryInjector: { inject: async () => [] } as any,
  } as any)
  const a = await cb.build({ utterance: "x", tier: "smart", conversationId: "c" })
  const b = await cb.build({ utterance: "y", tier: "smart", conversationId: "c" })
  expect(a.system).toContain("hint#1")
  expect(b.system).toContain("hint#2") // re-evaluated per turn, not frozen in the cached prefix
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

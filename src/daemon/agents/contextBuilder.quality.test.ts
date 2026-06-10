// Per-turn context QUALITY controls: the pre-retrieval gate (skip memory recall on filler)
// and the delta budget (one fat memory hit can't blow the window).
import { test, expect } from "bun:test"
import { ContextBuilder, needsMemoryRecall } from "./contextBuilder"

test("needsMemoryRecall: greetings/acks skip recall; real requests don't", () => {
  for (const u of ["hey", "Hi!", "what's up", "ok", "thanks", "sounds good", "yep", "Good morning", "never mind", "how's it going?"])
    expect(needsMemoryRecall(u)).toBe(false)
  for (const u of ["what's on my calendar today?", "remind me what we decided about the demo",
                   "send Sam an email", "yes, send it to the team list", "who is Patel?"])
    expect(needsMemoryRecall(u)).toBe(true)
})

function builderWith(injectCalls: string[], hits: any[] = []) {
  return new ContextBuilder({
    loaders: {
      soulDigest: async () => "soul",
      standingOrdersSummary: async () => "",
      memoryOverview: async () => "",
      kairosSkills: async () => [],
      introspectionTools: async () => [],
    },
    memoryInjector: { inject: async (q: string) => { injectCalls.push(q); return hits } },
  } as any)
}

test("a greeting turn performs NO memory lookup at all", async () => {
  const calls: string[] = []
  const b = builderWith(calls)
  await b.build({ utterance: "hey, how's it going?", tier: "fast" })
  expect(calls.length).toBe(0)
})

test("a real request DOES perform the memory lookup", async () => {
  const calls: string[] = []
  const b = builderWith(calls)
  await b.build({ utterance: "what did we decide about the demo?", tier: "smart" })
  expect(calls).toEqual(["what did we decide about the demo?"])
})

test("delta budget: a giant memory hit is clipped, and total delta stays bounded", async () => {
  const calls: string[] = []
  const giant = { source: "L3", text: "X".repeat(5000), ts: Date.now() - 3 * 86400_000 }
  const b = builderWith(calls, [giant, { source: "L2", text: "small fact", ts: Date.now() }])
  const { system } = await b.build({ utterance: "tell me about the project", tier: "smart" })
  const delta = system.split("## Current context")[1] ?? ""
  expect(delta.length).toBeLessThan(3200)            // bounded, not 5000+
  expect(delta).toContain("…")                       // the giant hit was clipped
  expect(delta).toMatch(/3d ago/)                    // age annotation present
})

// ── connected-apps injection (live toolkit awareness) ──────────────────────────────
import { connectedAppsLine } from "./contextBuilder"

test("connected apps are injected fresh into BOTH tiers' prompts", async () => {
  const b = new ContextBuilder({
    loaders: {
      soulDigest: async () => "s", standingOrdersSummary: async () => "", memoryOverview: async () => "",
      kairosSkills: async () => [], introspectionTools: async () => [],
      connectedApps: async () => ["gmail", "googlecalendar", "notion"],
    },
  } as any)
  const smart = await b.build({ utterance: "add a page to my notion", tier: "smart" })
  expect(smart.system).toContain("Gmail (gmail)")
  expect(smart.system).toContain("Notion (notion)")
  expect(smart.system).toContain("NOT connected")          // the anything-else rule
  const fast = await b.build({ utterance: "is notion connected?", tier: "fast" })
  expect(fast.system).toContain("Notion (notion)")          // the front knows too
})

test("zero connected apps says so plainly (offer-to-connect)", () => {
  expect(connectedAppsLine([])).toContain("none yet")
})

test("no connectedApps loader → no apps block (graceful)", async () => {
  const b = new ContextBuilder({
    loaders: { soulDigest: async () => "s", standingOrdersSummary: async () => "", memoryOverview: async () => "", kairosSkills: async () => [], introspectionTools: async () => [] },
  } as any)
  const { system } = await b.build({ utterance: "hi there friend", tier: "fast" })
  expect(system).not.toContain("Connected apps")
})

test("self-poisoning guard: KAIROS's own failure echoes are never injected as memory", async () => {
  const calls: string[] = []
  const hits = [
    { source: "L2", text: 'User said: "open the page". KAIROS replied: "I\'m having trouble retrieving the content."', ts: Date.now() },
    { source: "L3", text: "The user's manager is Sarah Chen (sarah@x.com).", ts: Date.now() },
  ]
  const b = new ContextBuilder({
    loaders: { soulDigest: async () => "s", standingOrdersSummary: async () => "", memoryOverview: async () => "", kairosSkills: async () => [], introspectionTools: async () => [] },
    memoryInjector: { inject: async (q: string) => { calls.push(q); return hits } },
  } as any)
  const { system } = await b.build({ utterance: "what's inside the CERTUS-AI page?", tier: "smart" })
  expect(system).not.toContain("having trouble")      // failure echo dropped
  expect(system).toContain("Sarah Chen")              // real memory survives
})

// src/daemon/memory/pendingResolver.test.ts — Unit 3
import { describe, it, expect } from "bun:test"
import { PendingResolver } from "./pendingResolver"

function stores(pending: any[]) {
  const forgot: Array<{ subject?: string }> = []
  const cleared: string[] = []
  let live = [...pending]
  return {
    forgot, cleared, get live() { return live },
    semanticStore: {
      livePending: () => live,
      forget: async (_q: string, opts?: any) => { forgot.push({ subject: opts?.subject }); return { superseded: ["x"] } },
      clearPending: async (opts: any) => { cleared.push(opts.id); live = live.filter(p => p.id !== opts.id); return 1 },
    },
    episodicStore: { forgetWhere: async () => 1 },
  }
}
const llm = (decisions: any[]) => ({ complete: async () => ({ text: JSON.stringify({ decisions }) }) })

describe("PendingResolver (Unit 3)", () => {
  it("no pending → null, no LLM call", async () => {
    let called = false
    const s = stores([])
    const r = new PendingResolver({ ...s, llm: { complete: async () => { called = true; return { text: "{}" } } } })
    expect(await r.resolve("yes")).toBeNull()
    expect(called).toBe(false)
  })

  it("confirm → executes forget(subject) + clears marker", async () => {
    const s = stores([{ id: "m1", text: 'NEEDS CONFIRMATION [cid:c]: user asked to forget "name"', subject: "name", category: "_pending_confirmation" }])
    const r = new PendingResolver({ ...s, llm: llm([{ id: "m1", decision: "confirm" }]) })
    const out = await r.resolve("yes delete it", "c")
    expect(out).toEqual({ resolved: 1 })
    expect(s.forgot[0].subject).toBe("name")
    expect(s.cleared).toContain("m1")
  })

  it("deny → clears marker, does NOT forget", async () => {
    const s = stores([{ id: "m1", text: 'forget "name"', subject: "name", category: "_pending_confirmation" }])
    const r = new PendingResolver({ ...s, llm: llm([{ id: "m1", decision: "deny" }]) })
    await r.resolve("no keep it")
    expect(s.forgot.length).toBe(0)
    expect(s.cleared).toContain("m1")
  })

  it("unclear → leaves pending (not cleared, not forgotten)", async () => {
    const s = stores([{ id: "m1", text: 'forget "name"', subject: "name", category: "_pending_confirmation" }])
    const r = new PendingResolver({ ...s, llm: llm([{ id: "m1", decision: "unclear" }]) })
    await r.resolve("what's the weather")
    expect(s.forgot.length).toBe(0)
    expect(s.cleared.length).toBe(0)
  })

  it("conversation scoping: ignores markers tagged for a different cid", async () => {
    const s = stores([{ id: "m1", text: 'NEEDS CONFIRMATION [cid:other]: forget "x"', subject: "x", category: "_pending_confirmation" }])
    const r = new PendingResolver({ ...s, llm: llm([{ id: "m1", decision: "confirm" }]) })
    const out = await r.resolve("yes", "mine")
    expect(out).toBeNull()        // different cid → not acted on
    expect(s.forgot.length).toBe(0)
  })
})

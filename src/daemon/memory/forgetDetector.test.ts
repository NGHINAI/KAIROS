// src/daemon/memory/forgetDetector.test.ts — Unit 2
import { describe, it, expect } from "bun:test"
import { ForgetDetector } from "./forgetDetector"

function stores() {
  const forgotten: string[] = []
  const l2: string[] = []
  const recorded: any[] = []
  return {
    forgotten, l2, recorded,
    semanticStore: {
      forget: async (q: string) => { forgotten.push(q); return { superseded: ["id1"] } },
      record: async (i: any) => { recorded.push(i); return "pid" },
    },
    episodicStore: { forgetWhere: async (t: string) => { l2.push(t); return 1 } },
  }
}
const llm = (j: object) => ({ complete: async () => ({ text: JSON.stringify(j) }) })

describe("ForgetDetector (Unit 2)", () => {
  it("trivial+clear forget → immediate soft-delete L3 + L2", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "forget", target: "husk", scope: "fact", importance: "low", vague: false, confidence: 0.95 }) })
    const out = await fd.detect("forget everything about husk")
    expect(out).toEqual({ forgot: ["id1"] })
    expect(s.forgotten).toContain("husk")
    expect(s.l2).toContain("husk")
    expect(s.recorded.length).toBe(0) // no pending marker for trivial
  })

  it("a RECALL QUESTION never triggers a forget — even if the cheap LLM misfires (live bug)", async () => {
    const s = stores()
    // The fast model falsely returned intent:"forget" for "How do I take my coffee?" in a
    // live run and RETIRED the coffee fact. The deterministic no-forget-cue guard overrides it.
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "forget", target: "coffee preference", scope: "preference", importance: "low", vague: false, confidence: 0.9 }) })
    expect(await fd.detect("How do I take my coffee?")).toBeNull()
    expect(await fd.detect("what's my favorite color?")).toBeNull()
    expect(await fd.detect("do you know my name?")).toBeNull()
    expect(s.forgotten.length).toBe(0)   // NOTHING retired by a question
  })

  it("an explicit forget still works (the guard doesn't block real forget verbs)", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "forget", target: "coffee", scope: "preference", importance: "low", vague: false, confidence: 0.9 }) })
    expect(await fd.detect("forget what I told you about my coffee")).toEqual({ forgot: ["id1"] })
  })

  it("IMPORTANT target (name) → pending confirmation, NOT deleted", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "forget", target: "name", scope: "fact", importance: "high", vague: false, confidence: 0.9 }) })
    const out = await fd.detect("forget my name")
    expect(out).toEqual({ pending: "name" })
    expect(s.forgotten.length).toBe(0)           // nothing deleted yet
    expect(s.recorded[0].category).toBe("_pending_confirmation")
    expect(s.recorded[0].text).toMatch(/cid:/)   // conversation-scoped
  })

  it("VAGUE target → pending confirmation", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "forget", target: "that", scope: "all", importance: "low", vague: true, confidence: 0.9 }) })
    const out = await fd.detect("forget that")
    expect((out as any)?.pending).toBe("that")
    expect(s.forgotten.length).toBe(0)
  })

  it("low confidence → pending (don't act unsure)", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "forget", target: "budget", scope: "fact", importance: "low", vague: false, confidence: 0.4 }) })
    expect((await fd.detect("uh maybe forget the budget thing"))).toEqual({ pending: "budget" })
  })

  it("intent=none (delete real project) → no-op", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: llm({ intent: "none", target: "", scope: "fact", importance: "low", vague: false, confidence: 0.9 }) })
    expect(await fd.detect("delete the Husk project")).toBeNull()
    expect(s.forgotten.length).toBe(0)
  })

  it("llm failure → null (non-fatal)", async () => {
    const s = stores()
    const fd = new ForgetDetector({ ...s, llm: { complete: async () => { throw new Error("down") } } })
    expect(await fd.detect("forget husk")).toBeNull()
  })
})

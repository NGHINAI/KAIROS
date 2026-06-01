// src/daemon/memory/factWriter.test.ts
// Unit 2 — smart-write layer: the three resolution branches + degradation.
import { describe, it, expect } from "bun:test"
import { FactWriter } from "./factWriter"

function fakeStore() {
  const recorded: Array<{ text: string; subject?: string; category?: string }> = []
  const superseded: string[] = []
  return {
    recorded, superseded,
    record: async (input: any) => { recorded.push(input); return `id-${recorded.length}` },
    recall: async (_q: string, _n: number) => existing,
    supersede: async (id: string) => { superseded.push(id) },
  }
  // existing facts injected per-test below
}
let existing: Array<{ id: string; text: string }> = []

function judgeLlm(judgement: object) {
  return { complete: async () => ({ text: JSON.stringify(judgement) }) }
}

describe("FactWriter (Unit 2)", () => {
  it("skip: duplicate fact records nothing", async () => {
    existing = [{ id: "e1", text: "user's name is Nirmal" }]
    const store = fakeStore()
    const fw = new FactWriter({ semanticStore: store as any, llm: judgeLlm({ action: "skip", supersedeIds: [], subject: "user name", category: "identity", importance: "high", confidence: 0.9 }) })
    const out = await fw.write("user's name is Nirmal")
    expect(out.action).toBe("skip")
    expect(store.recorded.length).toBe(0)
    expect(store.superseded.length).toBe(0)
  })

  it("auto-supersede: LOW importance contradiction retires old + records new silently", async () => {
    existing = [{ id: "e1", text: "user's favorite color is teal" }]
    const store = fakeStore()
    const fw = new FactWriter({ semanticStore: store as any, llm: judgeLlm({ action: "supersede", supersedeIds: ["e1"], subject: "favorite color", category: "preferences", importance: "low", confidence: 0.6 }) })
    const out = await fw.write("user's favorite color is blue")
    expect(out.action).toBe("supersede")
    expect(store.superseded).toEqual(["e1"])
    expect(store.recorded.some(r => /blue/.test(r.text))).toBe(true)
    // No pending-confirmation marker for a low-importance change.
    expect(store.recorded.some(r => r.category === "_pending_confirmation")).toBe(false)
  })

  it("auto-supersede: HIGH importance but HIGH confidence (>=0.85) still auto-resolves", async () => {
    existing = [{ id: "e1", text: "user's name is Nirmal" }]
    const store = fakeStore()
    const fw = new FactWriter({ semanticStore: store as any, llm: judgeLlm({ action: "supersede", supersedeIds: ["e1"], subject: "user name", category: "identity", importance: "high", confidence: 0.95 }) })
    const out = await fw.write("user's name is now Nirmal Ghinaiya")
    expect(out.action).toBe("supersede")
    expect(store.superseded).toEqual(["e1"])
  })

  it("pending-confirmation: HIGH importance + LOW confidence asks instead of overwriting", async () => {
    existing = [{ id: "e1", text: "user's name is Nirmal" }]
    const store = fakeStore()
    const fw = new FactWriter({ semanticStore: store as any, llm: judgeLlm({ action: "supersede", supersedeIds: ["e1"], subject: "user name", category: "identity", importance: "high", confidence: 0.4 }) })
    const out = await fw.write("user's name is Numa")
    expect(out.action).toBe("pending_confirmation")
    // Old fact NOT retired yet — we ask first.
    expect(store.superseded.length).toBe(0)
    // New fact recorded + a _pending_confirmation marker written.
    expect(store.recorded.some(r => /Numa/.test(r.text))).toBe(true)
    expect(store.recorded.some(r => r.category === "_pending_confirmation")).toBe(true)
  })

  it("new: novel subject just records with category", async () => {
    existing = []
    const store = fakeStore()
    const fw = new FactWriter({ semanticStore: store as any, llm: judgeLlm({ action: "new", supersedeIds: [], subject: "project", category: "projects", importance: "high", confidence: 0.9 }) })
    const out = await fw.write("user's project is Husk")
    expect(out.action).toBe("new")
    expect(store.recorded[0].category).toBe("projects")
  })

  it("degrades: LLM failure still records the fact (never loses it)", async () => {
    existing = []
    const store = fakeStore()
    const fw = new FactWriter({ semanticStore: store as any, llm: { complete: async () => { throw new Error("down") } } })
    const out = await fw.write("user works at Acme")
    expect(out.action).toBe("new")
    expect(store.recorded.length).toBe(1)
  })
})

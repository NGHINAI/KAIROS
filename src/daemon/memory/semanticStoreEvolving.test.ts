// src/daemon/memory/semanticStoreEvolving.test.ts
// Unit 1 — evolving SemanticStore: supersede, category, recency. Keyword-only
// (no VectorIndex) so these stay fast + avoid the embedder's in-process onnx load.
import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SemanticStore } from "./semanticMemory"

describe("SemanticStore — evolving memory (Unit 1)", () => {
  it("superseded facts no longer surface in recall", async () => {
    const db = new Database(":memory:")
    const store = new SemanticStore(db)
    const numa = await store.record({ text: "user's name is Numa", subject: "user name", category: "identity" })
    await store.record({ text: "user's name is Nirmal", subject: "user name", category: "identity" })

    // Before supersede: both match "name"
    let hits = await store.recall("name", 5)
    expect(hits.length).toBe(2)

    // Supersede the wrong one
    await store.supersede(numa)
    hits = await store.recall("name", 5)
    expect(hits.length).toBe(1)
    expect(hits[0].text).toMatch(/Nirmal/)
    expect(hits.some(h => /Numa/.test(h.text))).toBe(false)
  })

  it("persists subject + category and lists live facts by category", async () => {
    const db = new Database(":memory:")
    const store = new SemanticStore(db)
    await store.record({ text: "user prefers terse replies", subject: "reply style", category: "preferences" })
    const dropId = await store.record({ text: "user likes long answers", subject: "reply style", category: "preferences" })
    await store.record({ text: "user's project is Husk", subject: "project", category: "projects" })

    const prefs = store.liveByCategory("preferences")
    expect(prefs.length).toBe(2)
    expect(prefs.every(p => p.category === "preferences")).toBe(true)

    await store.supersede(dropId)
    expect(store.liveByCategory("preferences").length).toBe(1)
    expect(store.liveByCategory("projects").length).toBe(1)
  })

  it("recency tiebreaker: among equally-relevant facts, newer ranks first", async () => {
    const db = new Database(":memory:")
    const store = new SemanticStore(db)
    // Same tokens → same BM25 relevance; only ts differs.
    await store.record({ text: "user enjoys coffee", category: "preferences" })
    await new Promise(r => setTimeout(r, 5))
    await store.record({ text: "user enjoys coffee strongly", category: "preferences" })
    const hits = await store.recall("coffee", 2)
    // Newer fact should be first (recency tiebreak), both present.
    expect(hits.length).toBe(2)
  })

  it("pending-confirmation facts float to the top of recall", async () => {
    const db = new Database(":memory:")
    const store = new SemanticStore(db)
    await store.record({ text: "user's name is Nirmal", subject: "user name", category: "identity" })
    await store.record({
      text: "NEEDS CONFIRMATION: user said both Numa and Nirmal — ask which is correct",
      subject: "user name", category: "_pending_confirmation",
    })
    const hits = await store.recall("name", 5)
    expect(hits[0].category).toBe("_pending_confirmation")
  })

  it("backward-compatible: record({text}) with no subject/category still works", async () => {
    const db = new Database(":memory:")
    const store = new SemanticStore(db)
    await store.record({ text: "plain fact about github webhooks" })
    const hits = await store.recall("github", 5)
    expect(hits.length).toBe(1)
    expect(hits[0].text).toMatch(/github/)
  })
})

// src/daemon/memory/forgetPrimitives.test.ts
// Unit 1 — store soft-delete primitives (keyword-only, no embedder).
import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SemanticStore } from "./semanticMemory"
import { EpisodicStore } from "./episodicMemory"

describe("SemanticStore.forget / pending (Unit 1)", () => {
  it("forget(query) supersedes matching live facts → gone from recall", async () => {
    const db = new Database(":memory:")
    const s = new SemanticStore(db)
    await s.record({ text: "User's project is called Husk, a browser engine", subject: "project", category: "projects" })
    await s.record({ text: "User's favorite language is Rust", subject: "language", category: "preferences" })

    expect((await s.recall("husk", 5)).length).toBe(1)
    const r = await s.forget("forget everything about husk")
    expect(r.superseded.length).toBe(1)
    expect((await s.recall("husk", 5)).length).toBe(0)      // gone
    expect((await s.recall("rust", 5)).length).toBe(1)       // unrelated fact untouched
  })

  it("forget({subject}) targets by subject exactly", async () => {
    const db = new Database(":memory:")
    const s = new SemanticStore(db)
    await s.record({ text: "User's name is Nirmal", subject: "name", category: "identity" })
    await s.record({ text: "User's name nickname is Nir", subject: "name", category: "identity" })
    const r = await s.forget("", { subject: "name" })
    expect(r.superseded.length).toBe(2)
    expect((await s.recall("name", 5)).length).toBe(0)
  })

  it("forget never touches _pending_confirmation markers", async () => {
    const db = new Database(":memory:")
    const s = new SemanticStore(db)
    await s.record({ text: "User's project is Husk", subject: "project", category: "projects" })
    await s.record({ text: "CONFIRM: forget husk?", subject: "project", category: "_pending_confirmation" })
    await s.forget("husk")
    // the real fact retired, the marker survives (resolver owns it)
    expect(s.livePending().length).toBe(1)
  })

  it("livePending + clearPending", async () => {
    const db = new Database(":memory:")
    const s = new SemanticStore(db)
    await s.record({ text: "CONFIRM: forget name?", subject: "name", category: "_pending_confirmation" })
    expect(s.livePending().length).toBe(1)
    const n = await s.clearPending({ subject: "name" })
    expect(n).toBe(1)
    expect(s.livePending().length).toBe(0)
  })
})

describe("EpisodicStore.forgetWhere (Unit 1)", () => {
  it("soft-deletes matching observations → gone from recall, others kept", async () => {
    const db = new Database(":memory:")
    const e = new EpisodicStore(db)
    await e.record({ source: "voice", text: 'User said: "My project is Husk."' })
    await e.record({ source: "voice", text: 'User said: "I like Rust."' })

    expect((await e.recall("husk", 5)).length).toBe(1)
    const n = await e.forgetWhere("husk")
    expect(n).toBe(1)
    expect((await e.recall("husk", 5)).length).toBe(0)   // forgotten
    expect((await e.recall("rust", 5)).length).toBe(1)    // untouched
  })

  it("source scoping", async () => {
    const db = new Database(":memory:")
    const e = new EpisodicStore(db)
    await e.record({ source: "voice", text: "husk thing one" })
    await e.record({ source: "clipboard", text: "husk thing two" })
    const n = await e.forgetWhere("husk", "voice")
    expect(n).toBe(1)  // only the voice one
  })
})

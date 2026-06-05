// src/daemon/memory/semanticMemory.personalization.test.ts
// Tests the personalization additions WITHOUT a vector index (keyword-only mode),
// so they run without onnxruntime (which crashes bun in this env).
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { SemanticStore } from "./semanticMemory"

function store() {
  return new SemanticStore(new Database(":memory:")) // no vectorIndex → keyword-only
}

test("topFacts returns the highest-confidence live facts, excluding pending + superseded", async () => {
  const s = store()
  await s.record({ text: "User's name is Nirmal", subject: "name", confidence: 0.95 })
  await s.record({ text: "User prefers terse replies", subject: "style", confidence: 0.9 })
  await s.record({ text: "A low-confidence aside", subject: "aside", confidence: 0.2 })
  await s.record({ text: "NEEDS CONFIRMATION about foo", subject: "foo", category: "_pending_confirmation", confidence: 1 })
  const top = s.topFacts(2)
  expect(top.map((t) => t.subject)).toEqual(["name", "style"]) // pending excluded despite conf=1
})

test("topFacts excludes superseded facts", async () => {
  const s = store()
  const id = await s.record({ text: "old fact", subject: "x", confidence: 0.99 })
  await s.record({ text: "kept fact", subject: "y", confidence: 0.5 })
  await s.supersede(id)
  const top = s.topFacts(5)
  expect(top.some((t) => t.text === "old fact")).toBe(false)
  expect(top.some((t) => t.text === "kept fact")).toBe(true)
})

test("recall SUPPRESSES a contested subject's facts while a pending confirmation is open (surfaces the question, not the stale fact)", async () => {
  const s = store()
  await s.record({ text: "User's name is Alpha", subject: "name", confidence: 0.6 })
  await s.record({ text: "NEEDS CONFIRMATION about name: Alpha vs Beta", subject: "name", category: "_pending_confirmation", confidence: 1 })
  const hits = await s.recall("name", 5)
  expect(hits.some((h) => h.category === "_pending_confirmation")).toBe(true) // question surfaces
  // The contested FACT (non-pending) is suppressed — the pending marker may itself mention Alpha.
  expect(hits.filter((h) => h.category !== "_pending_confirmation").some((h) => h.text.includes("Alpha"))).toBe(false)
})

test("recall still returns non-contested subjects normally when a pending exists for a different subject", async () => {
  const s = store()
  await s.record({ text: "User works at Certus", subject: "employer", confidence: 0.9 })
  await s.record({ text: "NEEDS CONFIRMATION about name", subject: "name", category: "_pending_confirmation", confidence: 1 })
  const hits = await s.recall("Certus employer", 5)
  expect(hits.some((h) => h.text.includes("Certus"))).toBe(true) // unrelated subject unaffected
})

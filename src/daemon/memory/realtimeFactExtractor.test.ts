// src/daemon/memory/realtimeFactExtractor.test.ts
import { describe, expect, test } from "bun:test"
import { RealtimeFactExtractor } from "./realtimeFactExtractor"

describe("RealtimeFactExtractor", () => {
  test("stores durable facts immediately", async () => {
    const stored: string[] = []
    const ex = new RealtimeFactExtractor({
      llm: { complete: async () => ({ text: '["User\'s name is Nirmal","User prefers terse replies"]' }) },
      factWriter: { write: async (text: string) => { stored.push(text); return {} } },
    })
    const out = await ex.extract("My name is Nirmal and I like short answers.")
    expect(out.length).toBe(2)
    expect(stored).toContain("User's name is Nirmal")
  })

  test("empty array for chitchat → nothing stored", async () => {
    const stored: string[] = []
    const ex = new RealtimeFactExtractor({
      llm: { complete: async () => ({ text: "[]" }) },
      factWriter: { write: async (text: string) => { stored.push(text); return {} } },
    })
    expect(await ex.extract("what's up?")).toEqual([])
    expect(stored.length).toBe(0)
  })

  test("very short utterance skipped without an LLM call", async () => {
    let called = false
    const ex = new RealtimeFactExtractor({
      llm: { complete: async () => { called = true; return { text: "[]" } } },
      factWriter: { write: async () => ({}) },
    })
    expect(await ex.extract("hi")).toEqual([])
    expect(called).toBe(false)
  })

  test("LLM failure is non-fatal", async () => {
    const ex = new RealtimeFactExtractor({
      llm: { complete: async () => { throw new Error("down") } },
      factWriter: { write: async () => ({}) },
    })
    expect(await ex.extract("My company is Acme Corp.")).toEqual([])
  })

  test("tolerant parse of fenced output", async () => {
    const stored: string[] = []
    const ex = new RealtimeFactExtractor({
      llm: { complete: async () => ({ text: 'facts:\n```json\n["User works at Acme"]\n```' }) },
      factWriter: { write: async (text: string) => { stored.push(text); return {} } },
    })
    await ex.extract("I work at Acme Corp doing platform engineering.")
    expect(stored).toEqual(["User works at Acme"])
  })
})

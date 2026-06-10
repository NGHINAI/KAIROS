// src/daemon/agents/recallTool.test.ts
import { test, expect } from "bun:test"
import { buildRecallTool } from "./recallTool"

const DAY = 86400_000

test("recall_memory returns age-annotated text hits from L2+L3", async () => {
  const tool = buildRecallTool({
    injector: {
      inject: async (q, opts) => {
        expect(q).toBe("sam's email")
        expect(opts?.include_l4).toBe(false)
        return [
          { text: "Sam's email is sam@acme.com", source: "L3", ts: Date.now() - 3 * DAY },
          { text: "User asked KAIROS to email Sam about the demo", source: "L2", ts: Date.now() - 2 * 3600_000 },
        ]
      },
    },
  })
  expect(tool.name).toBe("recall_memory")
  expect(tool.concurrencySafe).toBe(true)
  const out = await tool.execute({ query: "sam's email" })
  expect(typeof out).toBe("string")
  expect(out).toContain("[L3 · 3d ago] Sam's email is sam@acme.com")
  expect(out).toContain("[L2 · 2h ago]")
  expect(out).toContain("may be stale")
})

test("failure-echo memories are filtered out (no learned helplessness via JIT recall)", async () => {
  const tool = buildRecallTool({
    injector: {
      inject: async () => [
        { text: "KAIROS replied: I'm having trouble retrieving the Notion page.", source: "L2", ts: Date.now() },
      ],
    },
  })
  const out = await tool.execute({ query: "notion page" })
  expect(out).toContain("Nothing relevant in memory")
  expect(out).not.toContain("having trouble")
})

test("empty results tell the model not to invent", async () => {
  const tool = buildRecallTool({ injector: { inject: async () => [] } })
  const out = await tool.execute({ query: "the thing" })
  expect(out).toMatch(/don'?t invent/i)
})

test("an injector failure degrades gracefully", async () => {
  const tool = buildRecallTool({ injector: { inject: async () => { throw new Error("db locked") } } })
  const out = await tool.execute({ query: "anything" })
  expect(out).toContain("Memory search failed")
})

test("an empty query is rejected with instructions, not a lookup", async () => {
  let called = false
  const tool = buildRecallTool({ injector: { inject: async () => { called = true; return [] } } })
  const out = await tool.execute({ query: "  " })
  expect(called).toBe(false)
  expect(out).toContain("non-empty query")
})

test("oversized hits are clipped so one memory can't dominate the observation", async () => {
  const tool = buildRecallTool({
    injector: { inject: async () => [{ text: "x".repeat(900), source: "L3", ts: Date.now() }] },
  })
  const out = await tool.execute({ query: "big" })
  const line = out.split("\n")[1] ?? ""
  expect(line.length).toBeLessThanOrEqual(320)
  expect(line).toContain("…")
})

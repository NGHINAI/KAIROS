import { test, expect } from "bun:test"
import { Conductor } from "./conductor"

// Bug 5 — an empty/whitespace fast reply must NEVER produce a silent turn; the guard
// emits a spoken fallback. (The session's recorded reply="" was actually the
// supersede/abort — Bug 4-truncation — but the empty-content guard must hold regardless.)
const classifyFast = { complete: async () => ({ text: '{"tier":"fast","reason":"x","confidence":0.9}' }) }
const stub = { complete: async () => ({ text: "" }) }
const ctx = { build: async () => ({ system: "SYS", tools: [] as any[] }) }

test("an empty fast model reply emits the spoken fallback (never silent)", async () => {
  let done = ""
  const c = new Conductor({
    classifyLlm: classifyFast,
    fastLlm: { complete: async () => ({ text: "   \n  " }) },  // whitespace-only
    smartLlm: stub, tools: [], contextBuilder: ctx as any,
    onEvent: (e) => { if (e.kind === "agent_done") done = e.text },
  })
  await c.handle({ conversationId: "c", utterance: "Okay." })
  expect(done.trim().length).toBeGreaterThan(0)
  expect(done.toLowerCase()).toContain("catch") // the "didn't catch that" fallback
})

test("a think-only fast reply (stripped to empty) also falls back, never silent", async () => {
  let done = ""
  const c = new Conductor({
    classifyLlm: classifyFast,
    fastLlm: { complete: async () => ({ text: "<think>reasoning only, no answer</think>" }) },
    smartLlm: stub, tools: [], contextBuilder: ctx as any,
    onEvent: (e) => { if (e.kind === "agent_done") done = e.text },
  })
  await c.handle({ conversationId: "c", utterance: "hi" })
  expect(done.trim().length).toBeGreaterThan(0)
  expect(done).not.toContain("<think>")
})

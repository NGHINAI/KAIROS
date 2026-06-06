import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { Conductor, type PlannerRunner } from "./conductor"
import { ConversationMessageStore } from "../voice/conversationMessageStore"
import type { LoopMsg } from "./loop/types"

// REGRESSION GATE for the 2026-06-05 "you are fucking dumb" session.
// Arc: user sends an email (tool returns a gmail threadId) → user says "reply to that
// same email". Before the fix, the threadId was discarded at turn end and the reply
// turn had nothing to act on, so it re-asked the user. This test proves the threadId
// now survives into the NEXT turn's planner context via durable replay.

function stubLlm(text = "") { return { complete: async () => ({ text }) } }
const classifySmart = { complete: async () => ({ text: '{"tier":"smart","reason":"action","confidence":0.95}' }) }
const stubContext = { build: async () => ({ system: "SYS", tools: [] as any[] }) }

const SEND_RESULT = { data: { id: "19e9976612c3c003", threadId: "19e9976612c3c003", labelIds: ["SENT"] }, successful: true }

test("REGRESSION: 'reply to that same email' receives the prior turn's threadId in its planner history", async () => {
  const msgStore = new ConversationMessageStore(new Database(":memory:"))

  let capturedReplyHistory: LoopMsg[] = []
  let turn = 0
  const runPlanner: PlannerRunner = async (_input, opts) => {
    turn++
    if (turn === 1) {
      // The SEND turn: the model called GMAIL_SEND_EMAIL and got back a threadId.
      return {
        finalOutput: "The email is sent.",
        toolCalls: [{ id: "t0", name: "execute_tool", args: { tool: "GMAIL_SEND_EMAIL", recipient_email: "pateln062@gmail.com" }, result: SEND_RESULT }],
      }
    }
    // The REPLY turn: capture what history the planner was seeded with.
    capturedReplyHistory = opts.history ?? []
    return { finalOutput: "Done — replied to that thread.", toolCalls: [] }
  }

  const conductor = new Conductor({
    classifyLlm: classifySmart,
    fastLlm: stubLlm(),
    smartLlm: stubLlm(),
    tools: [],
    contextBuilder: stubContext as any,
    onEvent: () => {},
    runPlanner,
    conversationMessages: msgStore,
  })

  await conductor.handle({ conversationId: "c1", utterance: "send an email to pateln062@gmail.com saying I'm available tomorrow" })
  await conductor.handle({ conversationId: "c1", utterance: "reply to that same email please" })

  // The thread id from the SEND turn must be present in the REPLY turn's planner context.
  const historyJson = JSON.stringify(capturedReplyHistory)
  expect(historyJson).toContain("19e9976612c3c003")
  // And it must arrive as a real tool message (replayable), not as discarded prose.
  expect(capturedReplyHistory.some(m => m.role === "tool")).toBe(true)
  // The user's original send request is in context too (so the model knows the recipient).
  expect(historyJson).toContain("pateln062@gmail.com")
})

test("a smart turn triggers the off-hot-path rolling-summary update", async () => {
  const msgStore = new ConversationMessageStore(new Database(":memory:"))
  let resolveCalled!: () => void
  const called = new Promise<void>((r) => { resolveCalled = r })
  let summaryUpdated = false
  const runPlanner: PlannerRunner = async () => ({ finalOutput: "done", toolCalls: [] })
  const c = new Conductor({
    classifyLlm: classifySmart, fastLlm: stubLlm(), smartLlm: stubLlm(), tools: [], contextBuilder: stubContext as any, onEvent: () => {}, runPlanner,
    conversationMessages: {
      loadForReplay: (id, o) => msgStore.loadForReplay(id, o),
      appendTurn: (id, t, m) => msgStore.appendTurn(id, t, m),
      updateRollingSummary: async () => { summaryUpdated = true; resolveCalled() },
    },
  })
  await c.handle({ conversationId: "c3", utterance: "do the thing" })
  await called  // the update is fire-and-forget; wait for it
  expect(summaryUpdated).toBe(true)
})

test("rolling summary suppressed when KAIROS_CONV_SUMMARY=0", async () => {
  const prev = process.env.KAIROS_CONV_SUMMARY
  process.env.KAIROS_CONV_SUMMARY = "0"
  try {
    const msgStore = new ConversationMessageStore(new Database(":memory:"))
    let updated = false
    const runPlanner: PlannerRunner = async () => ({ finalOutput: "done", toolCalls: [] })
    const c = new Conductor({
      classifyLlm: classifySmart, fastLlm: stubLlm(), smartLlm: stubLlm(), tools: [], contextBuilder: stubContext as any, onEvent: () => {}, runPlanner,
      conversationMessages: { loadForReplay: (id, o) => msgStore.loadForReplay(id, o), appendTurn: (id, t, m) => msgStore.appendTurn(id, t, m), updateRollingSummary: async () => { updated = true } },
    })
    await c.handle({ conversationId: "c4", utterance: "do it" })
    await new Promise((r) => setTimeout(r, 10))
    expect(updated).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.KAIROS_CONV_SUMMARY; else process.env.KAIROS_CONV_SUMMARY = prev
  }
})

test("replay is suppressed when KAIROS_CONV_REPLAY=0", async () => {
  const prev = process.env.KAIROS_CONV_REPLAY
  process.env.KAIROS_CONV_REPLAY = "0"
  try {
    const msgStore = new ConversationMessageStore(new Database(":memory:"))
    let captured: LoopMsg[] | undefined
    let turn = 0
    const runPlanner: PlannerRunner = async (_i, opts) => {
      turn++
      if (turn === 1) return { finalOutput: "sent", toolCalls: [{ id: "t0", name: "execute_tool", args: {}, result: SEND_RESULT }] }
      captured = opts.history
      return { finalOutput: "ok", toolCalls: [] }
    }
    const c = new Conductor({ classifyLlm: classifySmart, fastLlm: stubLlm(), smartLlm: stubLlm(), tools: [], contextBuilder: stubContext as any, onEvent: () => {}, runPlanner, conversationMessages: msgStore })
    await c.handle({ conversationId: "c2", utterance: "send it" })
    await c.handle({ conversationId: "c2", utterance: "reply" })
    expect(captured ?? []).toEqual([])  // no replay history passed
  } finally {
    if (prev === undefined) delete process.env.KAIROS_CONV_REPLAY; else process.env.KAIROS_CONV_REPLAY = prev
  }
})

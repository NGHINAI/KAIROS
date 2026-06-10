import { test, expect, afterEach } from "bun:test"
import { Conductor, type PlannerRunner } from "./conductor"
import { setToolNature } from "./loop/verifier"

// The conductor classifies tool nature (read/write) via the agentic nature map. Seed it
// so GMAIL_SEND_EMAIL is a write (→ 'action') and GMAIL_FETCH_EMAILS a read (→ 'read').
setToolNature(new Map([["GMAIL_SEND_EMAIL", "write"], ["GMAIL_FETCH_EMAILS", "read"]]))
afterEach(() => setToolNature(null))

const classifySmart = { complete: async () => ({ text: '{"tier":"smart","reason":"x","confidence":0.9}' }) }
const stub = { complete: async () => ({ text: "" }) }
const front = { complete: async () => ({ text: "[[task]]" }) }   // fast-front routes to the planner
const ctx = { build: async () => ({ system: "SYS", tools: [] as any[] }) }

function conductorWith(recorder: { record: (e: any) => void }, runPlanner: PlannerRunner) {
  return new Conductor({ classifyLlm: classifySmart, fastLlm: front, smartLlm: stub, tools: [], contextBuilder: ctx as any, onEvent: () => {}, runPlanner, activity: recorder })
}

test("a write-tool turn is recorded as an 'action' with the effective tool + refs", async () => {
  const events: any[] = []
  const runPlanner: PlannerRunner = async () => ({
    finalOutput: "The email is sent.",
    toolCalls: [
      { id: "t0", name: "search_tools", args: { query: "send email" }, result: {} },
      { id: "t1", name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL", args: { recipient_email: "pateln062@gmail.com" } }, result: { data: { id: "19e99", threadId: "19e99" }, successful: true } },
    ],
  })
  await conductorWith({ record: (e) => events.push(e) }, runPlanner).handle({ conversationId: "c1", utterance: "email Patel I'm free tomorrow" })
  expect(events.length).toBe(1)
  expect(events[0].kind).toBe("action")
  expect(events[0].lane).toBe("foreground")
  expect(events[0].tool).toBe("GMAIL_SEND_EMAIL")     // unwrapped from execute_tool args
  expect(events[0].importance).toBe(0.8)
  expect(events[0].ref?.threadId).toBe("19e99")
  expect(events[0].detail).toContain("Patel")          // the user's request is the detail
})

test("a read-only-tool turn is recorded as a lower-importance 'read'", async () => {
  const events: any[] = []
  const runPlanner: PlannerRunner = async () => ({
    finalOutput: "Your latest email is from Stripe.",
    toolCalls: [{ id: "t0", name: "execute_tool", args: { tool_name: "GMAIL_FETCH_EMAILS" }, result: { data: { messages: [] } } }],
  })
  await conductorWith({ record: (e) => events.push(e) }, runPlanner).handle({ conversationId: "c1", utterance: "what's my latest email" })
  expect(events.length).toBe(1)
  expect(events[0].kind).toBe("read")
  expect(events[0].importance).toBe(0.4)
})

test("a chitchat turn (no tools) is NOT recorded", async () => {
  const events: any[] = []
  const runPlanner: PlannerRunner = async () => ({ finalOutput: "Hey! What's up?", toolCalls: [] })
  await conductorWith({ record: (e) => events.push(e) }, runPlanner).handle({ conversationId: "c1", utterance: "hey how's it going" })
  expect(events.length).toBe(0)
})

import { test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { ConversationMessageStore } from "./conversationMessageStore"
import type { LoopMsg } from "../agents/loop/types"

let store: ConversationMessageStore
beforeEach(() => { store = new ConversationMessageStore(new Database(":memory:")) })

// A realistic "send email" turn: user → assistant tool_calls → tool result (with the
// gmail threadId that the next turn needs) → assistant final answer.
function sendEmailTurn(): LoopMsg[] {
  return [
    { role: "user", content: "send an email to pateln062@gmail.com saying I'm available tomorrow" },
    { role: "assistant", tool_calls: [{ id: "t0", type: "function", function: { name: "execute_tool", arguments: '{"tool":"GMAIL_SEND_EMAIL"}' } }] },
    { role: "tool", tool_call_id: "t0", content: '{"data":{"id":"19e9976612c3c003","threadId":"19e9976612c3c003","labelIds":["SENT"]},"successful":true}' },
    { role: "assistant", content: "The email is sent." },
  ]
}

test("round-trips a turn and preserves the tool result (threadId survives)", async () => {
  await store.appendTurn("c1", "turnA", sendEmailTurn())
  const replay = await store.loadForReplay("c1")
  const joined = JSON.stringify(replay)
  expect(joined).toContain("19e9976612c3c003")           // the threadId carries forward
  expect(replay.some(m => m.role === "tool")).toBe(true) // tool result is a real message, not prose
  expect(replay.some(m => m.role === "user")).toBe(true)
})

test("never persists system messages (the next turn supplies its own prefix)", async () => {
  await store.appendTurn("c1", "turnA", [{ role: "system", content: "PREFIX" }, ...sendEmailTurn()])
  const replay = await store.loadForReplay("c1")
  expect(replay.some(m => m.role === "system")).toBe(false)
})

test("tool-pair integrity: every assistant tool_call id has a matching tool result, no orphans", async () => {
  await store.appendTurn("c1", "turnA", sendEmailTurn())
  const replay = await store.loadForReplay("c1")
  const callIds = new Set<string>()
  for (const m of replay) if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) callIds.add(c.id)
  const resultIds = new Set(replay.filter(m => m.role === "tool").map(m => (m as any).tool_call_id))
  for (const id of callIds) expect(resultIds.has(id)).toBe(true) // no dangling tool_call_id → no provider 400
})

test("maxTurns keeps only the most recent N whole turns", async () => {
  await store.appendTurn("c1", "turnA", [{ role: "user", content: "first message ALPHA" }, { role: "assistant", content: "ok" }])
  await store.appendTurn("c1", "turnB", [{ role: "user", content: "second message BETA" }, { role: "assistant", content: "ok" }])
  await store.appendTurn("c1", "turnC", [{ role: "user", content: "third message GAMMA" }, { role: "assistant", content: "ok" }])
  const replay = await store.loadForReplay("c1", { maxTurns: 2 })
  const joined = JSON.stringify(replay)
  expect(joined).not.toContain("ALPHA")  // oldest turn dropped
  expect(joined).toContain("BETA")
  expect(joined).toContain("GAMMA")
})

test("maxChars drops oldest WHOLE turns without splitting a tool pair", async () => {
  await store.appendTurn("c1", "turnA", sendEmailTurn())            // has a tool pair
  await store.appendTurn("c1", "turnB", [{ role: "user", content: "x".repeat(50) }, { role: "assistant", content: "y".repeat(50) }])
  const replay = await store.loadForReplay("c1", { maxChars: 120 })
  // Whatever survived must still be pair-complete (no tool msg without its assistant call).
  const callIds = new Set<string>()
  for (const m of replay) if (m.role === "assistant" && m.tool_calls) for (const c of m.tool_calls) callIds.add(c.id)
  for (const m of replay) if (m.role === "tool") expect(callIds.has((m as any).tool_call_id)).toBe(true)
})

test("unknown conversation returns empty replay", async () => {
  expect(await store.loadForReplay("nope")).toEqual([])
})

test("conversations are isolated", async () => {
  await store.appendTurn("c1", "tA", [{ role: "user", content: "SECRET_C1" }, { role: "assistant", content: "ok" }])
  await store.appendTurn("c2", "tB", [{ role: "user", content: "SECRET_C2" }, { role: "assistant", content: "ok" }])
  expect(JSON.stringify(await store.loadForReplay("c1"))).not.toContain("SECRET_C2")
})

// ── Rolling summary: turns OLDER than the recent window get folded into a summary so
// the conversation is remembered in full (recent verbatim + older summarized).
test("updateRollingSummary folds older turns into a summary; loadForReplay prepends it", async () => {
  for (let i = 0; i < 6; i++) {
    await store.appendTurn("c1", `t${i}`, [{ role: "user", content: `message number ${i} TOPIC${i}` }, { role: "assistant", content: "ok" }])
  }
  // Keep the most recent 2 turns verbatim; summarize everything older.
  const summarize = async (text: string) => `SUMMARY_OF[${text.length}chars]`
  await store.updateRollingSummary("c1", summarize, { keepRecent: 2 })

  const replay = await store.loadForReplay("c1", { maxTurns: 2 })
  const joined = JSON.stringify(replay)
  expect(joined).toContain("SUMMARY_OF")                 // summary injected as a system message
  expect(replay[0]!.role).toBe("system")                 // …at the front, before recent turns
  expect(joined).toContain("TOPIC5")                     // the most-recent turn is still verbatim
})

test("updateRollingSummary is incremental — only NEW older turns are folded each time", async () => {
  const seen: string[] = []
  const summarize = async (text: string) => { seen.push(text); return "S" }
  for (let i = 0; i < 4; i++) await store.appendTurn("c1", `t${i}`, [{ role: "user", content: `u${i}` }, { role: "assistant", content: "a" }])
  await store.updateRollingSummary("c1", summarize, { keepRecent: 2 })  // folds t0,t1
  const firstCallLen = seen.length
  for (let i = 4; i < 6; i++) await store.appendTurn("c1", `t${i}`, [{ role: "user", content: `u${i}` }, { role: "assistant", content: "a" }])
  await store.updateRollingSummary("c1", summarize, { keepRecent: 2 })  // folds t2,t3 (NOT t0,t1 again)
  expect(seen.length).toBeGreaterThan(firstCallLen)
  // The second fold must reference the new turns (u2/u3), not re-process u0/u1 from scratch.
  expect(seen[seen.length - 1]).toContain("u2")
})

test("updateRollingSummary is a no-op when there are no turns older than the window", async () => {
  let called = 0
  const summarize = async () => { called++; return "S" }
  await store.appendTurn("c1", "t0", [{ role: "user", content: "only one" }, { role: "assistant", content: "ok" }])
  await store.updateRollingSummary("c1", summarize, { keepRecent: 8 })
  expect(called).toBe(0)
})

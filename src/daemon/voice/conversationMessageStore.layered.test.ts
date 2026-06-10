// src/daemon/voice/conversationMessageStore.layered.test.ts
// The layered history pyramid: L0 raw turns → L1 per-turn digests → L2 rolling summary.
import { test, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { ConversationMessageStore, buildTurnDigest } from "./conversationMessageStore"

let store: ConversationMessageStore
beforeEach(() => { store = new ConversationMessageStore(new Database(":memory:")) })

const turn = (i: number) => [
  { role: "user" as const, content: `question number ${i} TOPIC${i}` },
  { role: "assistant" as const, content: `answer number ${i}` },
]

test("buildTurnDigest captures ask, reply, effective tool, and handles in one line", () => {
  const digest = buildTurnDigest([
    { turn_id: "t", role: "user", content: "email Sam the proposal", tool_calls: null, tool_call_id: null, at: 1 },
    { turn_id: "t", role: "assistant", content: null, tool_calls: JSON.stringify([{ id: "c1", function: { name: "execute_tool", arguments: JSON.stringify({ tool_name: "GMAIL_SEND_EMAIL", args: {} }) } }]), tool_call_id: null, at: 1 },
    { turn_id: "t", role: "tool", content: '{"successful":true,"data":{"threadId":"thr_889","id":"msg_4"}}', tool_calls: null, tool_call_id: "c1", at: 1 },
    { turn_id: "t", role: "assistant", content: "Sent — Sam has the proposal.", tool_calls: null, tool_call_id: null, at: 1 },
  ])
  expect(digest).toContain('user: "email Sam the proposal"')
  expect(digest).toContain("Sent — Sam has the proposal.")
  expect(digest).toContain("via gmail send email")     // execute_tool unwrapped
  expect(digest).toContain("threadId=thr_889")          // the chainable handle survives
  expect(digest.length).toBeLessThanOrEqual(320)
})

test("aged-out turns get digests; replay injects them as one block, raw window untouched", async () => {
  for (let i = 0; i < 6; i++) await store.appendTurn("c1", `t${i}`, turn(i))
  await store.updateRollingSummary("c1", async () => "S", { keepRecent: 2, l1Turns: 10 })

  const replay = await store.loadForReplay("c1", { maxTurns: 2 })
  const sys = replay.filter((m) => m.role === "system")
  expect(sys.length).toBe(1)                              // digests only — nothing old enough for L2 yet
  const block = String((sys[0] as any).content)
  expect(block).toContain("Earlier turns in this conversation")
  for (let i = 0; i < 4; i++) expect(block).toContain(`TOPIC${i}`)   // every aged-out turn, one line each
  expect(block).not.toContain("TOPIC4")                  // raw-window turns are NOT in the digest block
  const joined = JSON.stringify(replay)
  expect(joined).toContain("TOPIC5")                     // …they're still verbatim
})

test("turns older than L0+L1 dissolve into the summary and their digests are deleted", async () => {
  for (let i = 0; i < 8; i++) await store.appendTurn("c1", `t${i}`, turn(i))
  const summarize = async (text: string) => `SUMMARY[${text.includes("TOPIC0") ? "has-t0" : "no-t0"}]`
  // keepRecent=2, l1=3 → L0: t6,t7 · L1: t3,t4,t5 · L2: t0,t1,t2
  await store.updateRollingSummary("c1", summarize, { keepRecent: 2, l1Turns: 3 })

  const replay = await store.loadForReplay("c1", { maxTurns: 2 })
  const sys = replay.filter((m) => m.role === "system").map((m) => String((m as any).content))
  expect(sys.length).toBe(2)
  expect(sys[0]).toContain("SUMMARY[has-t0]")            // L2 first (oldest context first)
  expect(sys[1]).toContain("TOPIC3")                     // L1 digests after
  expect(sys[1]).toContain("TOPIC5")
  expect(sys[1]).not.toContain("TOPIC0")                 // folded turns live ONLY in the summary
  expect(sys[1]).not.toContain("TOPIC1")
})

test("digesting is incremental and idempotent across calls", async () => {
  for (let i = 0; i < 5; i++) await store.appendTurn("c1", `t${i}`, turn(i))
  await store.updateRollingSummary("c1", async () => "S", { keepRecent: 2, l1Turns: 10 })
  await store.updateRollingSummary("c1", async () => "S", { keepRecent: 2, l1Turns: 10 })
  const replay = await store.loadForReplay("c1", { maxTurns: 2 })
  const block = String((replay.find((m) => m.role === "system") as any).content)
  // each aged-out topic appears exactly once even after two compaction passes
  for (let i = 0; i < 3; i++) {
    expect(block.split(`TOPIC${i}`).length - 1).toBe(1)
  }
})

test("the digest block stays bounded for a very long conversation", async () => {
  for (let i = 0; i < 40; i++) {
    await store.appendTurn("c1", `t${i}`, [
      { role: "user", content: `a fairly long user message number ${i} `.repeat(4) },
      { role: "assistant", content: `a fairly long assistant answer number ${i} `.repeat(4) },
    ])
  }
  await store.updateRollingSummary("c1", async () => "S", { keepRecent: 4, l1Turns: 30 })
  await store.updateRollingSummary("c1", async () => "S", { keepRecent: 4, l1Turns: 30 }) // catch-up pass (20/call cap)
  const replay = await store.loadForReplay("c1", { maxTurns: 4 })
  const block = String((replay.find((m) => m.role === "system" && String((m as any).content).includes("Earlier turns")) as any).content)
  expect(block.length).toBeLessThanOrEqual(3000 + 80)    // L1_BLOCK_MAX_CHARS + header
})

test("l1Turns: 0 restores the flat two-layer behavior (no digest table use)", async () => {
  for (let i = 0; i < 6; i++) await store.appendTurn("c1", `t${i}`, turn(i))
  await store.updateRollingSummary("c1", async () => "FLAT_SUMMARY", { keepRecent: 2, l1Turns: 0 })
  const replay = await store.loadForReplay("c1", { maxTurns: 2 })
  const sys = replay.filter((m) => m.role === "system").map((m) => String((m as any).content))
  expect(sys.length).toBe(1)
  expect(sys[0]).toContain("FLAT_SUMMARY")
})

// Observation masking in replay: OLD tool results keep only their handles; recent stay raw.
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { ConversationMessageStore, maskToolResult } from "./conversationMessageStore"

const fat = (id: string) => JSON.stringify({
  successful: true,
  data: { id, threadId: "thread_" + id, labelIds: ["SENT"], body: "B".repeat(800) },
})

function turn(n: number) {
  return [
    { role: "user", content: `request ${n}` },
    { role: "assistant", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "GMAIL_SEND_EMAIL", arguments: "{}" } }] },
    { role: "tool", tool_call_id: `c${n}`, content: fat(`m${n}`) },
    { role: "assistant", content: `done ${n}` },
  ] as any[]
}

test("maskToolResult keeps handles + status, drops the body", () => {
  const masked = maskToolResult(fat("m1"))
  expect(masked).toContain("threadId=thread_m1")     // the id the reply-arc needs survives
  expect(masked).toContain("ok")
  expect(masked).not.toContain("B".repeat(100))      // body gone
  expect(masked.length).toBeLessThan(fat("m1").length / 2)
})

test("small results are left alone", () => {
  const s = JSON.stringify({ ok: true, id: "x1" })
  expect(maskToolResult(s)).toBe(s)
})

test("replay masks tool results in OLD turns but keeps the most recent turns raw", async () => {
  const store = new ConversationMessageStore(new Database(":memory:"))
  for (let i = 1; i <= 4; i++) await store.appendTurn("c1", `t${i}`, turn(i))
  const msgs = await store.loadForReplay("c1", { maxTurns: 8, keepRawTurns: 2 })
  const tools = msgs.filter((m: any) => m.role === "tool") as any[]
  expect(tools.length).toBe(4)
  expect(tools[0].content).toContain("[older result")        // turn 1: masked
  expect(tools[0].content).toContain("threadId=thread_m1")   // …but handle survives
  expect(tools[1].content).toContain("[older result")        // turn 2: masked
  expect(tools[2].content).toContain("B".repeat(100))        // turn 3: raw
  expect(tools[3].content).toContain("B".repeat(100))        // turn 4: raw
})

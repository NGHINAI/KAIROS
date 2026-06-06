import { test, expect } from "bun:test"
import { shapeToolResult, clampMiddle, executeToolCall } from "./toolExecutor"
import type { ToolDef } from "../types"

// A verbose Gmail fetch: 10 messages, each with a big body + payload + labels.
function bigFetch(n = 10) {
  return {
    data: {
      messages: Array.from({ length: n }, (_, i) => ({
        id: `msg_${i}`,
        threadId: `thread_${i}`,
        from: `sender${i}@example.com`,
        subject: `Subject ${i}`,
        snippet: `short preview ${i}`,
        body: "LOREM ".repeat(400),           // huge — must be dropped
        payload: { parts: Array.from({ length: 20 }, () => ({ data: "x".repeat(200) })) },
        labelIds: ["INBOX", "IMPORTANT", "CATEGORY_PERSONAL"],
      })),
    },
    successful: true,
  }
}

test("shapeToolResult projects list-shaped fetches to a compact whitelist (drops bodies/payloads)", () => {
  const shaped = shapeToolResult("GMAIL_FETCH_EMAILS", bigFetch(10))
  expect(shaped).not.toBeNull()
  const json = JSON.stringify(shaped)
  expect(json).toContain("thread_0")     // threadId PRESERVED
  expect(json).toContain("Subject 0")    // subject preserved
  expect(json).not.toContain("LOREM")    // body dropped
  expect(json).not.toContain("payload")  // payload dropped
  expect(json.length).toBeLessThan(JSON.stringify(bigFetch(10)).length / 3) // dramatically smaller
})

test("shapeToolResult preserves threadId — the field the email-reply arc needs", () => {
  const shaped: any = shapeToolResult("GMAIL_FETCH_EMAILS", bigFetch(3))
  expect(shaped.items[0].threadId).toBe("thread_0")
})

test("shapeToolResult does NOT shape a non-list result (e.g. a send) — returns null", () => {
  const send = { data: { id: "19e9976612c3c003", threadId: "19e9976612c3c003", labelIds: ["SENT"] }, successful: true }
  expect(shapeToolResult("GMAIL_SEND_EMAIL", send)).toBeNull()
})

test("clampMiddle keeps head AND tail (so ids at the end survive), with an elision marker", () => {
  const s = "HEAD_MARKER" + "y".repeat(5000) + "TAIL_MARKER"
  const out = clampMiddle(s, 1000)
  expect(out.length).toBeLessThan(1100)
  expect(out).toContain("HEAD_MARKER")
  expect(out).toContain("TAIL_MARKER")
  expect(out).toContain("elided")
})

test("executeToolCall shapes a verbose fetch result before it reaches the model", async () => {
  const tool: ToolDef = { name: "GMAIL_FETCH_EMAILS", description: "", parameters: {}, execute: async () => bigFetch(10) }
  const res = await executeToolCall({ id: "t0", name: "GMAIL_FETCH_EMAILS", argsJson: "{}" }, [tool])
  expect(res.ok).toBe(true)
  expect(res.content).toContain("thread_0")   // model still sees the threadId
  expect(res.content).not.toContain("LOREM")  // but not the bodies
  expect(res.content.length).toBeLessThan(6000)
})

test("executeToolCall leaves a small send result intact (threadId reachable)", async () => {
  const send = { data: { id: "19e9976612c3c003", threadId: "19e9976612c3c003" }, successful: true }
  const tool: ToolDef = { name: "GMAIL_SEND_EMAIL", description: "", parameters: {}, execute: async () => send }
  const res = await executeToolCall({ id: "t0", name: "GMAIL_SEND_EMAIL", argsJson: "{}" }, [tool])
  expect(res.content).toContain("19e9976612c3c003")
})

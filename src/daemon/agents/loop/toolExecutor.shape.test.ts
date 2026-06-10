import { test, expect } from "bun:test"
import { shapeObservation, clampMiddle, executeToolCall } from "./toolExecutor"
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

// ── shapeObservation: LISTS ──────────────────────────────────────────────────────
test("shapes a verbose list into an NL headline + compact rows (drops bodies/payloads)", () => {
  const out = shapeObservation("GMAIL_FETCH_EMAILS", bigFetch(10))
  expect(out).toMatch(/^Found 10 messages/)   // natural-language headline for the weak model
  expect(out).toContain("thread_0")           // threadId PRESERVED (the email-reply arc needs it)
  expect(out).toContain("Subject 0")
  expect(out).not.toContain("LOREM")          // body dropped
  expect(out).not.toContain("payload")        // payload dropped
  expect(out).not.toContain("labelIds")       // noise dropped
  expect(out.length).toBeLessThan(JSON.stringify(bigFetch(10)).length / 3)
})

test("list shaping is SHAPE-based, not tool-name-based (works for any toolkit)", () => {
  const linear = { data: { issues: [{ id: "ISS-1", title: "Fix login", state: "open", description: "x".repeat(2000) }] }, successful: true }
  const out = shapeObservation("LINEAR_WHATEVER", linear)   // name has no _FETCH/_LIST/_SEARCH
  expect(out).toMatch(/Found 1 issues/)
  expect(out).toContain("ISS-1")
  expect(out).toContain("Fix login")
  expect(out).not.toContain("xxxxxxxxx")       // long description dropped
})

test("top-N caps a huge list and notes the remainder", () => {
  const out = shapeObservation("X_SEARCH", bigFetch(60))
  expect(out).toContain("Found 60 messages (showing 25)")
  expect(out).toMatch(/35 more/)
})

// ── shapeObservation: SINGLE OBJECTS ────────────────────────────────────────────
test("a small single result passes through losslessly (handle reachable, not over-stripped)", () => {
  const send = { data: { id: "19e9976612c3c003", threadId: "19e9976612c3c003", labelIds: ["SENT"] }, successful: true }
  const out = shapeObservation("GMAIL_SEND_EMAIL", send)
  expect(out).toContain("19e9976612c3c003")    // id/handle reachable for follow-up — never lost
  expect(out).toContain("threadId")
  expect(out.length).toBeLessThan(300)         // small → not bloated, but not stripped to {}
})

test("a LARGE single object is shaped: title+status headline, blob dropped, ids kept", () => {
  const ev = { data: { summary: "Standup", status: "confirmed", id: "evt_1", payload: "x".repeat(2000) }, successful: true }
  const out = shapeObservation("GOOGLECALENDAR_GET_EVENT", ev)
  expect(out).toMatch(/^"Standup" — confirmed/)
  expect(out).toContain("evt_1")
  expect(out).not.toContain("xxxxxxxxx")        // noise blob (payload) dropped
})

// ── review fixes: envelope edge cases ──────────────────────────────────────────
test("double-wrapped Composio data.data is collapsed (NOT reported as a bare 'Done.')", () => {
  const nested = { successful: true, data: { data: { messages: [{ id: "m1", subject: "Hi", body: "x".repeat(2000) }] } } }
  const out = shapeObservation("GMAIL_FETCH_EMAILS", nested)
  expect(out).not.toMatch(/^Done\./)
  expect(out).toContain("m1")
  expect(out).toContain("Hi")
  expect(out).not.toContain("xxxxxxxxx")        // body still dropped
})

test("a falsy error value (0 / false / '') is NOT a failure — data is preserved", () => {
  expect(shapeObservation("X", { data: { id: "abc" }, error: 0 })).toContain("abc")
  expect(shapeObservation("X", { data: { id: "abc" }, error: false })).toContain("abc")
  expect(shapeObservation("X", { data: { id: "abc" }, error: 0 })).not.toContain("Failed")
})

test("a real failure with an empty message still gives a reason, never a bare 'Failed: '", () => {
  expect(shapeObservation("X", { successful: false, error: "" })).toMatch(/Failed:.*no message/)
  expect(shapeObservation("X", { error: ["a", "b"] })).toMatch(/Failed:/)   // array error → not generic-empty
})

test("a circular reference doesn't collapse the result — ids/titles survive", () => {
  const o: any = { id: "X1", title: "Hi" }; o.self = o
  const out = shapeObservation("X", { successful: true, data: o })
  expect(out).toContain("X1")
  expect(out).toContain("Hi")
  expect(out).not.toContain("[unserializable]")
})

// ── review fixes: handle/url preserved, content body kept ──────────────────────
test("a long handle/URL is kept (not dropped as a blob) on a shaped object", () => {
  const big = { data: { id: "f1", name: "report", download_url: "https://s3.example.com/" + "a".repeat(800), junk: "z".repeat(1500) }, successful: true }
  const out = shapeObservation("DRIVE_GET_FILE", big)
  expect(out).toContain("https://s3.example.com/")   // the handle the agent needs next
  expect(out).toContain("download_url")
  expect(out).not.toContain("zzzzzzzzz")             // genuine noise dropped
})

test("a single read's body is kept as a clamped excerpt (the point of GET_MESSAGE)", () => {
  const msg = { data: { id: "m1", subject: "Lunch?", body: "Hey, are we still on for lunch tomorrow at noon? ".repeat(40) }, successful: true }
  const out = shapeObservation("GMAIL_GET_MESSAGE", msg)
  expect(out).toContain("Lunch?")
  expect(out).toContain("still on for lunch")        // body excerpt reaches the model
  expect(out).toContain("m1")
})

// ── review fixes: faithfulness validator (reformatted numbers ok, invented/truncated rejected) ──
test("distill accepts a faithfully REFORMATTED number ($1,234.56 → 1234) but rejects an invented one", async () => {
  const tool: ToolDef = { name: "WEB_READ", description: "", parameters: {}, execute: async () => "x".repeat(9000) + " total $1,234.56 in revenue" }
  const ok = await executeToolCall({ id: "t", name: "WEB_READ", argsJson: "{}" }, [tool],
    { maxChars: 500, distill: async () => "Revenue was about 1234 dollars." })
  expect(ok.content).toBe("Revenue was about 1234 dollars.")          // separators-normalized → faithful
  const bad = await executeToolCall({ id: "t", name: "WEB_READ", argsJson: "{}" }, [tool],
    { maxChars: 500, distill: async () => "Revenue was 99999 dollars." })
  expect(bad.content).not.toBe("Revenue was 99999 dollars.")          // invented number → rejected
})

test("distill rejects a TRUNCATED id (substring of a real id is not a whole-token match)", async () => {
  const tool: ToolDef = { name: "WEB_READ", description: "", parameters: {}, execute: async () => "x".repeat(9000) + " order ABC12345XYZ shipped" }
  const r = await executeToolCall({ id: "t", name: "WEB_READ", argsJson: "{}" }, [tool],
    { maxChars: 500, distill: async () => "Order ABC12345 shipped." })
  expect(r.content).not.toBe("Order ABC12345 shipped.")               // ABC12345 ≠ ABC12345XYZ → rejected
})

// ── shapeObservation: ERRORS / SCALARS / EMPTY ─────────────────────────────────────
test("a failed result (successful:false / error) surfaces a plain failure, never a dump", () => {
  expect(shapeObservation("X", { successful: false, error: "Notion auth expired" })).toContain("Failed: Notion auth expired")
  expect(shapeObservation("X", { error: { message: "boom" } })).toContain("Failed: boom")
})

test("scalars / strings / empty pass through sensibly", () => {
  expect(shapeObservation("X", 42)).toBe("42")
  expect(shapeObservation("X", "just text")).toBe("just text")
  expect(shapeObservation("X", null)).toBe("(no result)")
  expect(shapeObservation("X", { successful: true, data: null })).toBe("Done.")
})

// ── clampMiddle (final safety net) ─────────────────────────────────────────────────
test("clampMiddle keeps head AND tail (so ids at the end survive), with an elision marker", () => {
  const s = "HEAD_MARKER" + "y".repeat(5000) + "TAIL_MARKER"
  const out = clampMiddle(s, 1000)
  expect(out.length).toBeLessThan(1100)
  expect(out).toContain("HEAD_MARKER")
  expect(out).toContain("TAIL_MARKER")
  expect(out).toContain("elided")
})

// ── executeToolCall: end-to-end (shapes content, keeps raw) ────────────────────────
test("executeToolCall shapes the model-facing content but keeps the RAW result for the system", async () => {
  const raw = bigFetch(10)
  const tool: ToolDef = { name: "GMAIL_FETCH_EMAILS", description: "", parameters: {}, execute: async () => raw }
  const res = await executeToolCall({ id: "t0", name: "GMAIL_FETCH_EMAILS", argsJson: "{}" }, [tool])
  expect(res.ok).toBe(true)
  expect(res.content).toContain("thread_0")        // model sees the threadId
  expect(res.content).not.toContain("LOREM")       // but not the bodies
  expect(res.content.length).toBeLessThan(6000)
  expect(res.result).toBe(raw)                     // RAW kept intact for verify gate / replay
})

test("executeToolCall surfaces a tool's failure envelope as a clean observation", async () => {
  const tool: ToolDef = { name: "NOTION_X", description: "", parameters: {}, execute: async () => ({ successful: false, error: "auth expired" }) }
  const res = await executeToolCall({ id: "t0", name: "NOTION_X", argsJson: "{}" }, [tool])
  expect(res.content).toContain("Failed: auth expired")
})

test("over-budget STRUCTURED data is truncated deterministically (no distiller invoked)", async () => {
  let distillCalls = 0
  const huge = { data: { items: Array.from({ length: 500 }, (_, i) => ({ id: `i${i}`, name: `item ${i}`, note: "n".repeat(50) })) }, successful: true }
  const tool: ToolDef = { name: "X_LIST", description: "", parameters: {}, execute: async () => huge }
  const res = await executeToolCall({ id: "t0", name: "X_LIST", argsJson: "{}" }, [tool],
    { maxChars: 1500, distill: async (t) => { distillCalls++; return t } })
  expect(res.content.length).toBeLessThanOrEqual(1600)
  expect(distillCalls).toBe(0)   // structured data is NEVER LLM-distilled (only prose is)
})

test("over-budget PROSE uses the distiller, but only if it's faithful (no invented ids)", async () => {
  const prose = "x".repeat(9000) + " ref ABC12345"
  const tool: ToolDef = { name: "WEB_READ", description: "", parameters: {}, execute: async () => prose }
  // faithful distill (every token present in source) → used
  const faithful = await executeToolCall({ id: "t", name: "WEB_READ", argsJson: "{}" }, [tool],
    { maxChars: 500, distill: async () => "Summary mentioning ref ABC12345." })
  expect(faithful.content).toBe("Summary mentioning ref ABC12345.")
  // unfaithful distill (invents an id not in source) → rejected, falls back to clamp
  const unfaithful = await executeToolCall({ id: "t", name: "WEB_READ", argsJson: "{}" }, [tool],
    { maxChars: 500, distill: async () => "Order XYZ99999 is ready." })
  expect(unfaithful.content).not.toBe("Order XYZ99999 is ready.")
  expect(unfaithful.content).toContain("elided")
})

// ── auto-bridge: direct slug calls route through execute_tool ──────────────────────
test("a direct Composio-slug call is bridged through execute_tool (calling convention forgiven)", async () => {
  const executed: any[] = []
  const tools: ToolDef[] = [{
    name: "execute_tool", description: "", parameters: {},
    execute: async (a: any) => { executed.push(a); return { successful: true, data: { id: "evt_1" } } },
  }]
  const r = await executeToolCall({ id: "t", name: "GOOGLECALENDAR_CREATE_EVENT", argsJson: '{"summary":"Sync"}' }, tools)
  expect(r.ok).toBe(true)
  expect(executed[0]).toEqual({ tool_name: "GOOGLECALENDAR_CREATE_EVENT", args: { summary: "Sync" } })
  expect(r.content).toContain("evt_1")
})

test("unknown slug WITHOUT execute_tool gets the teaching error (mentions execute_tool)", async () => {
  const r = await executeToolCall({ id: "t", name: "GOOGLECALENDAR_CREATE_EVENT", argsJson: "{}" }, [])
  expect(r.ok).toBe(false)
  expect(r.content).toContain("execute_tool")
})

test("a lowercase unknown tool is NOT bridged (only Composio-style slugs)", async () => {
  const tools: ToolDef[] = [{ name: "execute_tool", description: "", parameters: {}, execute: async () => "x" }]
  const r = await executeToolCall({ id: "t", name: "nope_tool", argsJson: "{}" }, tools)
  expect(r.ok).toBe(false)
})

test("a failure whose guidance lives in data.message keeps the FULL guidance (so the model can fix the call)", () => {
  const out = shapeObservation("GOOGLECALENDAR_CREATE_EVENT", {
    successful: false,
    data: { message: "Missing required field 'start_datetime'. REQUIRED: start_datetime (ISO 8601), event_duration_minutes." },
    error: null,
  })
  expect(out).toContain("start_datetime")            // the schema guidance survives
  expect(out).toContain("event_duration_minutes")
  expect(out).toContain("retry")                     // explicit fix-and-retry nudge
  expect(out).not.toContain("no message provided")
})

test("a guessed/nonexistent slug error teaches the search_tools recovery", async () => {
  const tools: ToolDef[] = [{
    name: "execute_tool", description: "", parameters: {},
    execute: async () => { throw new Error("Unable to retrieve tool with slug NOTION_GET_PAGE_CONTENT") },
  }]
  const r = await executeToolCall({ id: "t", name: "execute_tool", argsJson: '{"tool_name":"NOTION_GET_PAGE_CONTENT"}' }, tools)
  expect(r.ok).toBe(false)
  expect(r.content).toContain("do NOT guess names")
  expect(r.content).toContain("search_tools")
})

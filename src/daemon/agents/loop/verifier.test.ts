// src/daemon/agents/loop/verifier.test.ts
import { test, expect } from "bun:test"
import { buildDestructiveVerifier, isDestructiveCall, setToolNature } from "./verifier"

// The agentic per-tool nature map the resolver would install at boot (the model's
// own read/write labels). Tests classify against THIS, not a hardcoded verb list.
const NATURE = new Map<string, "read" | "write">([
  ["GMAIL_SEND_EMAIL", "write"], ["GMAIL_DELETE_MESSAGE", "write"], ["LINEAR_DELETE_ISSUE", "write"],
  ["GOOGLECALENDAR_QUICK_ADD", "write"], ["CALCOM_BOOK", "write"], ["GMAIL_SEND_AND_GET_RECEIPT", "write"],
  ["GMAIL_FETCH_EMAILS", "read"], ["LINEAR_LIST_ISSUES", "read"],
])
setToolNature(NATURE)

test("isDestructiveCall: read-only tools are NOT destructive", () => {
  expect(isDestructiveCall({ name: "search_tools", args: {} })).toBe(false)
  expect(isDestructiveCall({ name: "execute_tool", args: { tool_name: "LINEAR_LIST_ISSUES" } })).toBe(false)
  expect(isDestructiveCall({ name: "execute_tool", args: { tool_name: "GMAIL_FETCH_EMAILS" } })).toBe(false)
})

test("isDestructiveCall: sends/deletes/connects ARE destructive (incl. unwrapping execute_tool)", () => {
  expect(isDestructiveCall({ name: "connect_service", args: {} })).toBe(true)
  expect(isDestructiveCall({ name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" } })).toBe(true)
  expect(isDestructiveCall({ name: "execute_tool", args: { tool_name: "LINEAR_DELETE_ISSUE" } })).toBe(true)
})

test("local/scratch tools (edit_file, update_plan, grep…) are NOT destructive", () => {
  for (const name of ["read_file", "list_dir", "write_file", "edit_file", "grep", "glob", "update_plan", "run_shell"]) {
    expect(isDestructiveCall({ name, args: {} })).toBe(false)
  }
})

test("severity: a turn with a destructive tool is 'write'; a read-only turn is 'read'", async () => {
  const v = buildDestructiveVerifier({ llm: { complete: async () => ({ text: JSON.stringify({ ok: true }) }) } as any })
  const w = await v.verify({ utterance: "delete that", finalText: "Deleted.", toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_DELETE_MESSAGE" }, result: { ok: true } }] })
  expect(w.severity).toBe("write")
  const r = await v.verify({ utterance: "my latest email?", finalText: "It's from Temu.", toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_FETCH_EMAILS" }, result: { messages: [] } }] })
  expect(r.severity).toBe("read")
})

test("a run of only local tools (edit_file + update_plan) skips the verify LLM (fast path)", async () => {
  let called = 0
  const llm = { complete: async () => { called++; return { text: "{}" } } }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({ utterance: "edit the file", finalText: "done", toolCalls: [
    { name: "update_plan", args: { plan: [] }, result: "ok" },
    { name: "edit_file", args: { path: "x" }, result: "Edited x." },
  ] })
  expect(r.ok).toBe(true)
  expect(called).toBe(0)
})

test("no tools at all → ok, no LLM (a pure chat turn)", async () => {
  let called = 0
  const v = buildDestructiveVerifier({ llm: { complete: async () => { called++; return { text: "{}" } } } as any })
  const r = await v.verify({ utterance: "hey", finalText: "Hi!", toolCalls: [] })
  expect(r.ok).toBe(true)
  expect(called).toBe(0)
})

test("DETERMINISTIC: a write tool that ERRORED but the agent claims success → flagged with NO LLM call", async () => {
  let called = 0
  const llm = { complete: async () => { called++; return { text: JSON.stringify({ ok: true }) } } }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({
    utterance: "email Sam",
    finalText: "Sent!",
    toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" }, error: "NOT_CONNECTED" }],
  })
  expect(r.ok).toBe(false)
  expect(r.severity).toBe("write")
  expect(called).toBe(0) // caught for free, before any model call
})

test("DETERMINISTIC: a write whose RESULT body shows successful:false → flagged with no LLM", async () => {
  let called = 0
  const llm = { complete: async () => { called++; return { text: JSON.stringify({ ok: true }) } } }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({
    utterance: "delete it",
    finalText: "Deleted.",
    toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_DELETE_MESSAGE" }, result: { successful: false, error: "not found" } }],
  })
  expect(r.ok).toBe(false)
  expect(called).toBe(0)
})

test("GENERAL: phantom action — 'delete that' → 'Done. Deleted.' but only a FETCH ran → LLM flags it", async () => {
  // No write tool ran (no deterministic signal), so this goes to the LLM, which
  // sees the ledger has only a read and the claim says 'deleted' → unsupported.
  let seen: any = null
  const llm = { complete: async (b: any) => { seen = b; return { text: JSON.stringify({ ok: false, concern: "no delete was performed", correction: "I haven't deleted it yet — want me to?" }) } } }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({
    utterance: "delete that email please",
    finalText: "Done. Deleted.",
    toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_FETCH_EMAILS" }, result: { messages: [{ id: "m1" }] } }],
  })
  expect(r.ok).toBe(false)
  expect(r.concern).toMatch(/delete/i)
  expect(r.correction).toMatch(/haven't deleted/i)
  expect(r.severity).toBe("read") // no write tool ran → overlap tier
  // The full ledger (the read result) was given to the judge, not just writes.
  expect(JSON.stringify(seen)).toMatch(/GMAIL_FETCH_EMAILS/)
})

test("GENERAL: misread on a READ — 'last email is from X' but fetch returned Y → LLM flags + offers correction", async () => {
  const llm = { complete: async () => ({ text: JSON.stringify({ ok: false, concern: "the fetched email is from Temu, not the market", correction: "Your latest email is actually from Temu." }) }) }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({
    utterance: "what's my last email",
    finalText: "Your last email is from the market about a sale.",
    toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_FETCH_EMAILS" }, result: { messages: [{ from: "Temu", subject: "credit" }] } }],
  })
  expect(r.ok).toBe(false)
  expect(r.correction).toMatch(/Temu/)
})

test("grounded read → ok (LLM confirms the claim matches the result)", async () => {
  const llm = { complete: async () => ({ text: JSON.stringify({ ok: true, concern: "" }) }) }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({ utterance: "how many issues", finalText: "You have 7 open issues.", toolCalls: [{ name: "execute_tool", args: { tool_name: "LINEAR_LIST_ISSUES" }, result: { issues: new Array(7) } }] })
  expect(r.ok).toBe(true)
})

test("successful write + LLM confirms → ok", async () => {
  const llm = { complete: async () => ({ text: JSON.stringify({ ok: true, concern: "" }) }) }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({ utterance: "email Sam", finalText: "Sent.", toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" }, result: { id: "m1" } }] })
  expect(r.ok).toBe(true)
  expect(r.severity).toBe("write")
})

test("verifier LLM failure does NOT block (defaults ok) — never strand a real action", async () => {
  const llm = { complete: async () => { throw new Error("llm down") } }
  const v = buildDestructiveVerifier({ llm: llm as any })
  const r = await v.verify({ utterance: "email Sam", finalText: "Sent.", toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" }, result: {} }] })
  expect(r.ok).toBe(true)
})

test("nature map drives read/write (model's per-tool labels, no verb list); unmapped defaults differ per consumer", () => {
  const d = (tool_name: string) => isDestructiveCall({ name: "execute_tool", args: { tool_name } })
  // mapped writes — incl. verb-less QUICK_ADD/BOOK and compound SEND_AND_GET
  expect(d("GOOGLECALENDAR_QUICK_ADD")).toBe(true)
  expect(d("CALCOM_BOOK")).toBe(true)
  expect(d("GMAIL_SEND_AND_GET_RECEIPT")).toBe(true)
  // mapped reads
  expect(d("GMAIL_FETCH_EMAILS")).toBe(false)
  expect(d("LINEAR_LIST_ISSUES")).toBe(false)
  // UNMAPPED external tool → verifier/controller default = read (stream; the grounding LLM still verifies)
  expect(d("WEIRD_TOOLKIT_FROBNICATE")).toBe(false)
  // ...but the approval gate passes unmappedDefault:'write' → gate the unknown (safe side)
  expect(isDestructiveCall({ name: "execute_tool", args: { tool_name: "WEIRD_TOOLKIT_FROBNICATE" } }, { unmappedDefault: "write" })).toBe(true)
})

test("V4: an errored QUICK_ADD claimed as success is caught deterministically (no LLM)", async () => {
  let called = 0
  const v = buildDestructiveVerifier({ llm: { complete: async () => { called++; return { text: JSON.stringify({ ok: true }) } } } as any })
  const r = await v.verify({
    utterance: "add a 3pm meeting",
    finalText: "Booked! You're all set for 3pm.",
    toolCalls: [{ name: "execute_tool", args: { tool_name: "GOOGLECALENDAR_QUICK_ADD" }, error: "RATE_LIMITED" }],
  })
  expect(r.ok).toBe(false)
  expect(r.severity).toBe("write")
  expect(called).toBe(0) // caught for free, before the (biased-ok) LLM
})

test("errored write that was RETRIED successfully is NOT flagged (recovered)", async () => {
  const v = buildDestructiveVerifier({ llm: { complete: async () => ({ text: JSON.stringify({ ok: true }) }) } as any })
  const r = await v.verify({
    utterance: "send it",
    finalText: "Sent.",
    toolCalls: [
      { name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" }, error: "TIMEOUT" }, // first attempt failed
      { name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" }, result: { id: "m1" } }, // retry succeeded
    ],
  })
  expect(r.ok).toBe(true) // recovered → not a phantom
})

test("PROMISSORY final ('one moment', nothing done) is flagged → self-correct round", async () => {
  const v = buildDestructiveVerifier({ llm: { complete: async () => ({ text: JSON.stringify({ ok: true }) }) } as any })
  const r = await v.verify({
    utterance: "what's on my calendar today?",
    finalText: "I can check your calendar. One moment.",
    toolCalls: [{ name: "kairos_skill_agent_turn_smart", args: {}, result: { ok: true, output: "# prompt text" } }],
  })
  expect(r.ok).toBe(false)
  expect(r.concern).toMatch(/promise|do the task/i)
})

test("a promise IS legitimate when the work was handed off to the background lane", async () => {
  const v = buildDestructiveVerifier({ llm: { complete: async () => ({ text: JSON.stringify({ ok: true }) }) } as any })
  const r = await v.verify({
    utterance: "research flights for me",
    finalText: "I'm on it — I'll let you know what I find.",
    toolCalls: [{ name: "spawn_background_task", args: { goal: "research flights" }, result: "Started in the background" }],
  })
  expect(r.ok).toBe(true)
})

test("a long substantive answer containing 'let me check' mid-prose is NOT flagged", async () => {
  const v = buildDestructiveVerifier({ llm: { complete: async () => ({ text: JSON.stringify({ ok: true }) }) } as any })
  const r = await v.verify({
    utterance: "summarize my inbox",
    finalText: "You have 12 unread. The urgent one is from Sam about tomorrow's meeting — he asked to move it to 3pm. There are also two invoices due Friday. Let me check whether you want me to archive the rest, or should I leave them?",
    toolCalls: [{ name: "execute_tool", args: { tool_name: "GMAIL_FETCH_EMAILS" }, result: { messages: [{ id: "1" }] } }],
  })
  expect(r.ok).toBe(true)
})

test("zero-tool PROMISE final ('I'm going to create it') is flagged; offer-questions are not", async () => {
  const v = buildDestructiveVerifier({ llm: { complete: async () => ({ text: JSON.stringify({ ok: true }) }) } as any })
  const promise = await v.verify({ utterance: "schedule it", finalText: "Found the email. I'm going to create a calendar event for tomorrow at 3pm.", toolCalls: [] })
  expect(promise.ok).toBe(false)
  const offer = await v.verify({ utterance: "inbox?", finalText: "You have 12 unread; the urgent one is from Sam. Want me to archive the rest?", toolCalls: [] })
  expect(offer.ok).toBe(true)
  const chat = await v.verify({ utterance: "hi", finalText: "Hey! Good to hear from you.", toolCalls: [] })
  expect(chat.ok).toBe(true)
})

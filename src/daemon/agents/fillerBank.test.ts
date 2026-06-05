// src/daemon/agents/fillerBank.test.ts
import { test, expect, beforeEach } from "bun:test"
import { pickAck, pickFiller, describeAction, __resetFillerBank } from "./fillerBank"

beforeEach(() => __resetFillerBank())

test("internal/instant tools get NO ack", () => {
  expect(pickAck("search_tools")).toBe("")
  expect(pickAck("update_plan")).toBe("")
  expect(pickAck("background_tasks")).toBe("")
})

// ── DATA-AWARE: names the actual app / action / target ────────────────────────
test("a send names the action, object, AND recipient (real data, not generic)", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) seen.add(pickAck("execute_tool", { tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam@acme.com" } }))
  const all = [...seen].join(" | ")
  expect(all).toMatch(/email/i)          // the object
  expect(all).toMatch(/Sam/)             // the recipient, prettified from the email
  expect(all).toMatch(/send|sending/i)   // the action
  // and at least one variant names the app
  expect(all).toMatch(/Gmail/)
})

test("a list/look names the app + object ('pull up your Linear issues')", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 40; i++) seen.add(pickAck("execute_tool", { tool_name: "LINEAR_LIST_ISSUES" }))
  const all = [...seen].join(" | ")
  expect(all).toMatch(/issues/i)
  expect(all.toLowerCase()).toMatch(/pull up|checking|look/)
})

test("calendar create names the calendar app", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 30; i++) seen.add(pickAck("execute_tool", { tool_name: "GOOGLECALENDAR_CREATE_EVENT" }))
  const all = [...seen].join(" | ").toLowerCase()
  expect(all).toMatch(/event|calendar/)
})

test("connect_service names the app being connected", () => {
  const seen = new Set<string>()
  for (let i = 0; i < 30; i++) seen.add(pickAck("connect_service", { toolkit_slug: "linear" }))
  expect([...seen].join(" | ")).toMatch(/Linear/)
})

test("system tools are data-aware: write_file names the file, run_shell names the command", () => {
  const w = new Set<string>(); for (let i = 0; i < 20; i++) w.add(pickAck("write_file", { path: "out/report.html" }))
  expect([...w].join(" | ")).toMatch(/report\.html/)
  __resetFillerBank()
  const s = new Set<string>(); for (let i = 0; i < 20; i++) s.add(pickAck("run_shell", { command: "git status" }))
  expect([...s].join(" | ").toLowerCase()).toMatch(/git|running/)
})

test("unknown/unparseable tool falls back to a generic ack (never empty, never throws)", () => {
  const a = pickAck("execute_tool", { tool_name: "WEIRDTOOL" })
  expect(a.length).toBeGreaterThan(0)
  const b = pickAck("some_random_intent", {})
  expect(b.length).toBeGreaterThan(0)
})

test("never repeats the same phrase twice in a row", () => {
  let prev = ""
  for (let i = 0; i < 60; i++) {
    const a = pickAck("execute_tool", { tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam" } })
    expect(a).not.toBe(prev); prev = a
  }
})

test("describeAction parses app/verb/object/target", () => {
  const d = describeAction("execute_tool", { tool_name: "GMAIL_SEND_EMAIL", args: { to: "sam@x.com" } })
  expect(d.app).toBe("Gmail")
  expect(d.kind).toBe("do")
  expect(d.objPhrase).toContain("email")
  expect(d.target).toContain("Sam")
})

// ── fillers ──────────────────────────────────────────────────────────────────
test("fillers are non-empty + non-repeating, and can reference the in-flight action", () => {
  let prev = ""
  for (let i = 0; i < 30; i++) { const f = pickFiller(); expect(f.length).toBeGreaterThan(0); expect(f).not.toBe(prev); prev = f }
  __resetFillerBank()
  const withNoun = new Set<string>()
  for (let i = 0; i < 40; i++) withNoun.add(pickFiller("your issues"))
  expect([...withNoun].some((f) => /your issues/.test(f))).toBe(true) // sometimes references the action
})

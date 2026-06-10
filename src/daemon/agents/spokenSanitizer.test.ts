import { test, expect } from "bun:test"
import { sanitizeSpoken, SpokenStreamFilter } from "./spokenSanitizer"

// ── sanitizeSpoken (complete strings: replies, background reports, approval lines) ──
test("strips <think>/<reasoning> chain-of-thought blocks", () => {
  expect(sanitizeSpoken("<think>let me reason</think>The answer is 42.")).toBe("The answer is 42.")
  expect(sanitizeSpoken("<reasoning>x</reasoning> hi")).toBe("hi")
})

test("a dangling/unclosed think tag is dropped", () => {
  expect(sanitizeSpoken("ok <think>still thinking with no close")).toBe("ok")
})

test("tool-markup-as-text NEVER spoken — replaced with a recovery line", () => {
  expect(sanitizeSpoken("<tool_call>{...}")).toMatch(/snag|try again/i)
  expect(sanitizeSpoken("functions.gmail_send{")).toMatch(/snag|try again/i)
})

test("clean prose passes through; empty → empty", () => {
  expect(sanitizeSpoken("Your inbox is clear.")).toBe("Your inbox is clear.")
  expect(sanitizeSpoken("   ")).toBe("")
  expect(sanitizeSpoken(null)).toBe("")
})

test("markdown is stripped so TTS never speaks 'star'/'hash'/'backtick'", () => {
  expect(sanitizeSpoken("Here are your **best** options:")).toBe("Here are your best options:")
  expect(sanitizeSpoken("* United $812\n* ANA $890")).toBe("United $812 ANA $890")
  expect(sanitizeSpoken("## Summary\nAll good.")).toBe("Summary All good.")
  expect(sanitizeSpoken("Run `git log` to see it.")).toBe("Run git log to see it.")
  expect(sanitizeSpoken("See [the report](https://x.com/r).")).toBe("See the report.")
  expect(sanitizeSpoken("Cost is 5*3 dollars")).not.toContain("*")
})

test("internal infra names + raw tool slugs are never voiced", () => {
  expect(sanitizeSpoken("I'll use Composio to search.")).toBe("I'll use the integration to search.")
  expect(sanitizeSpoken("Calling GMAIL_SEND_EMAIL now.")).toBe("Calling gmail send email now.")
  expect(sanitizeSpoken("via GOOGLECALENDAR_CREATE_EVENT")).not.toMatch(/_/)
})

test("approval-style line is cleaned (markdown + slug)", () => {
  expect(sanitizeSpoken('Quick approval — I want to send **the report** via GMAIL_SEND_EMAIL.'))
    .toBe("Quick approval — I want to send the report via gmail send email.")
})

test("stream path also strips stray markdown chars", () => {
  const f = new SpokenStreamFilter()
  let out = ""
  for (const d of ["Your ", "**top** ", "pick is United."]) out += f.push(d)
  out += f.flush()
  expect(out).not.toContain("*")
  expect(out).toContain("top")
})

// ── SpokenStreamFilter (the LIVE delta path) ────────────────────────────────────
test("streams clean text through (with end flush), nothing lost", () => {
  const f = new SpokenStreamFilter()
  let out = ""
  for (const d of ["The ", "email ", "is ", "sent."]) out += f.push(d)
  out += f.flush()
  expect(out).toBe("The email is sent.")
})

test("a <think> block in the stream is never spoken", () => {
  const f = new SpokenStreamFilter()
  let out = ""
  for (const d of ["<think>", "secret reasoning ", "more</think>", "Hello there."]) out += f.push(d)
  out += f.flush()
  expect(out).not.toContain("secret")
  expect(out.trim()).toBe("Hello there.")
})

test("a tag split across deltas is held back, never spoken partially", () => {
  const f = new SpokenStreamFilter()
  let out = ""
  for (const d of ["Hi <thi", "nk>hidden</think> bye"]) out += f.push(d)
  out += f.flush()
  expect(out).not.toContain("<thi")
  expect(out).not.toContain("hidden")
  expect(out).toContain("Hi")
  expect(out).toContain("bye")
})

test("tool-markup poisons the stream — nothing after it is spoken", () => {
  const f = new SpokenStreamFilter()
  let out = ""
  for (const d of ["Sure ", "<tool_call>", "{gmail...}", " never speak this"]) out += f.push(d)
  out += f.flush()
  expect(out).not.toContain("tool_call")
  expect(out).not.toContain("never speak this")
  expect(f.poisonedFinal()).toBe(true)
})

test("UUIDs and long hex tokens are never spoken (ids stripped, names survive)", () => {
  const out = sanitizeSpoken('I found "CERTUS-AI" with ID 225dcd3a-b64b-80ce-b7c5-c742a80d80b8 and "Mike-Brief-AI" with ID 204dcd3a-b64b-80ae-9830-aaaaaaaaaaaa. Which one?')
  expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)   // no uuid fragments
  expect(out).toContain("CERTUS-AI")                     // names survive
  expect(out).toContain("Which one?")
  expect(sanitizeSpoken("the message id is 19eaf24c59b23d51, done")).not.toContain("19eaf24c59b23d51")
})

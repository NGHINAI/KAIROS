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

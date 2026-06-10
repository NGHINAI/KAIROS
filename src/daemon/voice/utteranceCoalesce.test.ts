import { test, expect } from "bun:test"
import { coalesceFragment } from "./utteranceCoalesce"

const opts = (priorLive: boolean, coalesceMs = 800) => ({ coalesceMs, priorLive })

test("folds a same-breath fragment into the prior text when the prior turn is still live", () => {
  // "Okay." in flight, "Can you?" 751ms later → one combined utterance.
  expect(coalesceFragment({ text: "Okay.", at: 1000 }, "Can you?", 1751, opts(true))).toBe("Okay. Can you?")
})

test("does NOT coalesce a genuinely new utterance after the prior turn finished", () => {
  // prior turn finished → not live → new utterance stands alone.
  expect(coalesceFragment({ text: "Okay.", at: 1000 }, "Can you?", 1751, opts(false))).toBe("Can you?")
})

test("does NOT coalesce when the gap exceeds the window", () => {
  expect(coalesceFragment({ text: "Okay.", at: 1000 }, "Can you?", 1000 + 2000, opts(true))).toBe("Can you?")
})

test("no prior utterance → stands alone", () => {
  expect(coalesceFragment(undefined, "Hello", 1000, opts(true))).toBe("Hello")
})

test("coalesceMs=0 disables coalescing", () => {
  expect(coalesceFragment({ text: "Okay.", at: 1000 }, "Can you?", 1100, opts(true, 0))).toBe("Can you?")
})

test("chains multiple fragments (each within the window)", () => {
  let prev = { text: "Send", at: 1000 }
  let out = coalesceFragment(prev, "the email", 1300, opts(true)) // "Send the email"
  prev = { text: out, at: 1300 }
  out = coalesceFragment(prev, "to Patel", 1600, opts(true))
  expect(out).toBe("Send the email to Patel")
})

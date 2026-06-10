// src/daemon/memory/voiceObservation.test.ts
import { test, expect } from "bun:test"
import { voiceTurnObservation } from "./voiceObservation"

test("a normal turn records both sides", () => {
  expect(voiceTurnObservation("what's my next meeting?", "Your next meeting is at 3pm with Sam."))
    .toBe('User said: "what\'s my next meeting?". KAIROS replied: "Your next meeting is at 3pm with Sam.".')
})

test("a failure-narrative reply is NOT memorized — only the user's words survive", () => {
  const out = voiceTurnObservation(
    "read me the CERTUS-AI notion page",
    "I'm having trouble retrieving the content of the page.",
  )
  expect(out).toBe('User said: "read me the CERTUS-AI notion page".')
  expect(out).not.toContain("having trouble")
})

test("other failure phrasings are caught too", () => {
  for (const reply of [
    "I was unable to retrieve that document.",
    "I couldn't find the page you mean.",
    "That tool requires a specific format I can't provide.",
    "I'll keep working on it and get back to you.",
  ]) {
    expect(voiceTurnObservation("do the thing", reply)).toBe('User said: "do the thing".')
  }
})

test("an empty reply records just the utterance", () => {
  expect(voiceTurnObservation("hello there", "")).toBe('User said: "hello there".')
})

test("a PROMISSORY reply is never memorized — recalled promises teach mimicry, not facts", () => {
  for (const reply of [
    "I've started looking into flights to San Francisco for you in the background. I'll let you know what I find.",
    "I'm on it — one moment.",
    "I'll check your calendar and get back to you.",
    "Okay, I'm going to create that event now.",
  ]) {
    expect(voiceTurnObservation("can you research flights?", reply)).toBe('User said: "can you research flights?".')
  }
})

test("substantive replies still get memorized (facts ARE valuable memory)", () => {
  const out = voiceTurnObservation("when's my flight?", "Your flight to SFO departs Thursday at 9am from JFK.")
  expect(out).toContain("departs Thursday at 9am")
})

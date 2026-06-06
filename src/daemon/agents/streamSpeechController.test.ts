// src/daemon/agents/streamSpeechController.test.ts
import { test, expect } from "bun:test"
import { StreamSpeechController } from "./streamSpeechController"
import type { LoopEvent } from "./loop/types"

function fakes() {
  const calls: string[] = []
  const speaker = {
    begin: () => calls.push("begin"),
    feed: (t: string) => calls.push(`feed:${t}`),
    end: async () => { calls.push("end") },
    cancel: () => calls.push("cancel"),
  }
  const ackPhrase = (n: string) => `[ack:${n}] `
  return { calls, speaker, ackPhrase }
}

const delta = (text: string): LoopEvent => ({ kind: "assistant_delta", text })
const toolStart = (name: string): LoopEvent => ({ kind: "tool_call_start", id: "c1", name, args: {} })
const final = (text: string): LoopEvent => ({ kind: "final", text })

test("streams assistant deltas to the speaker as they arrive", async () => {
  const { calls, speaker, ackPhrase } = fakes()
  const c = new StreamSpeechController({ speaker: speaker as any, ackPhrase })
  c.begin()
  c.handle(delta("You've "))
  c.handle(delta("got mail."))
  c.handle(final("You've got mail."))
  const spoken = await c.finish()
  expect(calls).toEqual(["begin", "feed:You've ", "feed:got mail.", "end"])
  expect(spoken).toBe("You've got mail.")
})

test("feeds a LIVE ack INLINE to the same speaker when a tool starts (no separate begin/end)", async () => {
  const { calls, speaker, ackPhrase } = fakes()
  const c = new StreamSpeechController({ speaker: speaker as any, ackPhrase })
  c.begin()
  c.handle(toolStart("GMAIL_FETCH_EMAILS"))
  c.handle(delta("Here's your latest."))
  await c.finish()
  expect(calls[0]).toBe("begin")
  expect(calls).toContain("feed:[ack:GMAIL_FETCH_EMAILS] ") // fed inline, not a separate speak
  expect(calls.indexOf("feed:[ack:GMAIL_FETCH_EMAILS] ")).toBeLessThan(calls.indexOf("feed:Here's your latest."))
  // exactly one begin + one end — the ack did NOT open a second speak session
  expect(calls.filter((c) => c === "begin").length).toBe(1)
  expect(calls.filter((c) => c === "end").length).toBe(1)
})

test("fires a filler if no event arrives within fillerMs, cleared on first event", async () => {
  const { calls, speaker } = fakes()
  let fillerFired = 0
  let timerFn: (() => void) | null = null
  const c = new StreamSpeechController({
    speaker: speaker as any,
    fillerMs: 500,
    onFiller: () => { fillerFired++ },
    setTimer: (fn) => { timerFn = fn; return 1 },
    clearTimer: () => { timerFn = null },
  })
  c.begin()
  expect(timerFn).not.toBeNull() // armed
  // simulate the timer firing (no event yet)
  timerFn!()
  expect(fillerFired).toBe(1)
})

test("a delta CLEARS the filler timer (no filler once tokens flow)", async () => {
  const { speaker } = fakes()
  let cleared = false
  const c = new StreamSpeechController({
    speaker: speaker as any,
    fillerMs: 500,
    onFiller: () => {},
    setTimer: () => 1,
    clearTimer: () => { cleared = true },
  })
  c.begin()
  c.handle(delta("hi"))
  expect(cleared).toBe(true)
})

test("filler phrase is fed INLINE to the speaker on a long wait (not just a notify hook)", async () => {
  const { calls, speaker } = fakes()
  let timerFn: (() => void) | null = null
  const c = new StreamSpeechController({
    speaker: speaker as any,
    fillerMs: 500,
    fillerPhrase: () => "still on it. ",
    maxFillers: 2,
    setTimer: (fn) => { timerFn = fn; return 1 },
    clearTimer: () => {},
  })
  c.begin()
  timerFn!() // long wait elapses
  expect(calls).toContain("feed:still on it. ")
})

test("filler RE-ARMS after a tool starts, capped at maxFillers (no endless trickle)", async () => {
  const { calls, speaker } = fakes()
  let timerFn: (() => void) | null = null
  const c = new StreamSpeechController({
    speaker: speaker as any,
    ackPhrase: (n) => `[ack:${n}] `,
    fillerMs: 500,
    fillerPhrase: () => "still working. ",
    maxFillers: 2,
    setTimer: (fn) => { timerFn = fn; return 1 },
    clearTimer: () => {},
  })
  c.begin()
  c.handle(toolStart("GMAIL_SEND_EMAIL")) // re-arms the filler for this slow tool
  timerFn!(); timerFn!(); timerFn!() // tool still running — fire 3x, cap at 2
  const fillers = calls.filter((x) => x === "feed:still working. ").length
  expect(fillers).toBe(2) // capped
})

test("ackPhrase receives the tool ARGS (so it can be tool-aware for execute_tool)", async () => {
  const { speaker } = fakes()
  const seen: any[] = []
  const c = new StreamSpeechController({ speaker: speaker as any, ackPhrase: (n, args) => { seen.push({ n, args }); return "" } })
  c.begin()
  c.handle({ kind: "tool_call_start", id: "c1", name: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" } })
  expect(seen[0]).toEqual({ n: "execute_tool", args: { tool_name: "GMAIL_SEND_EMAIL" } })
})

test("cancel() stops the speaker and suppresses further output (barge-in)", async () => {
  const { calls, speaker, ackPhrase } = fakes()
  const c = new StreamSpeechController({ speaker: speaker as any, ackPhrase })
  c.begin()
  c.cancel()
  c.handle(delta("should not speak"))
  await c.finish()
  expect(calls).toContain("cancel")
  expect(calls).not.toContain("feed:should not speak")
  expect(calls).not.toContain("end") // cancelled → don't end()
})

test("BLOCK WRITES: after a destructive tool, the live final claim is HELD (not spoken)", async () => {
  const { calls, speaker, ackPhrase } = fakes()
  const c = new StreamSpeechController({
    speaker: speaker as any,
    ackPhrase,
    isDestructive: (name) => name === "GMAIL_DELETE_MESSAGE",
  })
  c.begin()
  c.handle(delta("Okay, deleting that now. ")) // pre-action narration → spoken live
  c.handle(toolStart("GMAIL_DELETE_MESSAGE"))   // irreversible → start withholding the final claim
  c.handle(delta("Done. Deleted."))             // the CLAIM → must NOT be spoken live
  await c.finish()
  expect(c.suppressedFinal()).toBe(true)
  expect(calls).toContain("feed:Okay, deleting that now. ") // narration streamed
  expect(calls).toContain("feed:[ack:GMAIL_DELETE_MESSAGE] ") // ack streamed (pre-action intent)
  expect(calls).not.toContain("feed:Done. Deleted.") // the claim was held back for the verify gate
  expect(c.heldText()).toBe("Done. Deleted.")
})

test("read-only turn is unaffected — its answer streams live as before", async () => {
  const { calls, speaker, ackPhrase } = fakes()
  const c = new StreamSpeechController({
    speaker: speaker as any,
    ackPhrase,
    isDestructive: (name) => name === "GMAIL_DELETE_MESSAGE",
  })
  c.begin()
  c.handle(toolStart("GMAIL_FETCH_EMAILS")) // a read → no suppression
  c.handle(delta("Your latest is from Temu."))
  await c.finish()
  expect(c.suppressedFinal()).toBe(false)
  expect(calls).toContain("feed:Your latest is from Temu.")
})

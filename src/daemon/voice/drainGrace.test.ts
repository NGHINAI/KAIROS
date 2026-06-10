// src/daemon/voice/drainGrace.test.ts
import { test, expect } from "bun:test"
import { supersedeSpeech } from "./drainGrace"
import { StreamingSpeaker } from "./streamingSpeaker"

function slowBackend(msPerPhrase: number) {
  const spokenFully: string[] = []
  let stopped = 0
  return {
    spokenFully, getStopped: () => stopped,
    backend: {
      speak: async (t: string) => { await new Promise((r) => setTimeout(r, msPerPhrase)); spokenFully.push(t) },
      stop: () => { stopped++ },
    },
  }
}

test("an idle speaker is left alone", async () => {
  const { backend, getStopped } = slowBackend(5)
  const s = new StreamingSpeaker({ backend })
  expect(await supersedeSpeech(s)).toBe("idle")
  expect(getStopped()).toBe(0)
})

test("a short, nearly-finished tail drains to completion instead of being cut", async () => {
  const { backend, spokenFully, getStopped } = slowBackend(20)
  const s = new StreamingSpeaker({ backend })
  s.begin()
  s.feed("Your next meeting is at three.")   // one short phrase mid-speech
  const out = await supersedeSpeech(s, { graceChars: 120, graceMs: 2000 })
  expect(out).toBe("drained")
  expect(spokenFully).toContain("Your next meeting is at three.")
  expect(getStopped()).toBe(0)               // never cut the audio
})

test("a punctuation-less tail fragment still gets flushed and spoken", async () => {
  const { backend, spokenFully } = slowBackend(10)
  const s = new StreamingSpeaker({ backend })
  s.begin()
  s.feed("got it")                            // no sentence boundary → sits in buf
  const out = await supersedeSpeech(s, { graceChars: 120, graceMs: 1000 })
  expect(out).toBe("drained")
  expect(spokenFully).toContain("got it")
})

test("a long in-flight reply is a real interrupt — cancelled immediately", async () => {
  const { backend, getStopped } = slowBackend(50)
  const s = new StreamingSpeaker({ backend })
  s.begin()
  s.feed("First sentence here. Second sentence here. Third sentence here. Fourth sentence here. Fifth one too. And a sixth for good measure. ")
  const out = await supersedeSpeech(s, { graceChars: 60, graceMs: 2000 })
  expect(out).toBe("cancelled")
  expect(getStopped()).toBeGreaterThan(0)
  expect(s.remaining()).toBe(0)               // queue wiped
})

test("a tail that can't finish within the grace window is cancelled", async () => {
  const { backend } = slowBackend(500)        // each phrase takes 500ms
  const s = new StreamingSpeaker({ backend })
  s.begin()
  s.feed("Short but slow. ")
  const out = await supersedeSpeech(s, { graceChars: 120, graceMs: 80 })
  expect(out).toBe("cancelled")
})

test("remaining() counts buffer, queue, and the phrase mid-TTS", async () => {
  const { backend } = slowBackend(50)
  const s = new StreamingSpeaker({ backend })
  s.begin()
  s.feed("One two three. ")                   // phrase → queue → starts speaking
  await new Promise((r) => setTimeout(r, 10)) // now mid-TTS
  s.feed("and a tail")                        // buffered, no boundary
  expect(s.remaining()).toBeGreaterThanOrEqual("One two three.".length + "and a tail".length)
  s.cancel()
})

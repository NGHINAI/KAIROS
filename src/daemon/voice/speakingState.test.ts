// src/daemon/voice/speakingState.test.ts
import { test, expect } from "bun:test"
import { SpeakingStateTracker } from "./speakingState"
import { StreamingSpeaker } from "./streamingSpeaker"

function tracker(opts: { rendererFreshMs?: number } = {}) {
  const events: boolean[] = []
  let t = 1_000_000
  const tr = new SpeakingStateTracker({
    broadcast: (e) => events.push(e.speaking),
    now: () => t,
    rendererFreshMs: opts.rendererFreshMs,
  })
  return { tr, events, tick: (ms: number) => { t += ms } }
}

test("broadcasts agent_speaking on CHANGE only (no per-phrase strobe)", () => {
  const { tr, events } = tracker()
  tr.reportSynthesis(true)
  tr.reportSynthesis(true)   // phrase 2, 3… of the same reply
  tr.reportSynthesis(true)
  tr.reportSynthesis(false)
  expect(events).toEqual([true, false])
})

test("renderer playback truth overrides the synthesis envelope while fresh", () => {
  const { tr, events } = tracker()
  tr.reportSynthesis(true)          // synthesis started → speaking
  tr.reportPlayback(true)           // renderer confirms audio
  tr.reportSynthesis(false)         // chunks done downloading — audio still playing
  expect(tr.speaking).toBe(true)    // playback truth wins: orb keeps speaking
  tr.reportPlayback(false)          // audio actually finished
  expect(tr.speaking).toBe(false)
  expect(events).toEqual([true, false])
})

test("falls back to the synthesis envelope when renderer acks go stale", () => {
  const { tr, tick } = tracker({ rendererFreshMs: 5000 })
  tr.reportPlayback(false)          // a renderer was here once
  tick(60_000)                      // …but quit an hour ago
  tr.reportSynthesis(true)
  expect(tr.speaking).toBe(true)    // envelope drives HUD-only setups
  tr.reportSynthesis(false)
  expect(tr.speaking).toBe(false)
})

test("keepalive acks keep the renderer authoritative through a long reply", () => {
  const { tr, tick } = tracker({ rendererFreshMs: 5000 })
  tr.reportPlayback(true)
  tr.reportSynthesis(false)         // synthesis finished way ahead of playback
  for (let i = 0; i < 5; i++) { tick(2000); tr.reportPlayback(true) }  // 2s keepalives
  expect(tr.speaking).toBe(true)    // never flickered to the (false) synthesis signal
  tr.reportPlayback(false)
  expect(tr.speaking).toBe(false)
})

test("a broadcast failure never throws into the voice path", () => {
  const tr = new SpeakingStateTracker({ broadcast: () => { throw new Error("ws gone") } })
  expect(() => tr.reportSynthesis(true)).not.toThrow()
})

// ── StreamingSpeaker envelope ──

test("the speaker's envelope spans a whole multi-sentence reply (no dips between phrases)", async () => {
  const events: boolean[] = []
  const s = new StreamingSpeaker({
    backend: { speak: async () => { await new Promise((r) => setTimeout(r, 10)) }, stop: () => {} },
    onSpeaking: (v) => events.push(v),
  })
  s.begin()
  s.feed("First sentence. Second sentence. ")
  s.feed("Third sentence.")
  await s.end()
  expect(events).toEqual([true, false])   // exactly one rise and one fall
})

test("cancel drops the envelope immediately", async () => {
  const events: boolean[] = []
  const s = new StreamingSpeaker({
    backend: { speak: async () => { await new Promise((r) => setTimeout(r, 200)) }, stop: () => {} },
    onSpeaking: (v) => events.push(v),
  })
  s.begin()
  s.feed("A long sentence to speak. ")
  await new Promise((r) => setTimeout(r, 20))   // mid-speak
  s.cancel()
  expect(events).toEqual([true, false])
})

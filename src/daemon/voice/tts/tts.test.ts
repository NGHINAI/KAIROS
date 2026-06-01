// src/daemon/voice/tts/tts.test.ts
import { describe, expect, test } from "bun:test"
import { DeepgramTts } from "./deepgramTts"
import { OpenAiTts } from "./openaiTts"
import { StreamingTtsBackend, ttsFromEnv, type AudioSink } from "./index"

/** Build a fetch that streams the given byte chunks as a chunked body. */
function streamingFetch(chunks: Uint8Array[], status = 200): typeof fetch {
  return (async (_url: string, _init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(c)
        controller.close()
      },
    })
    return new Response(status === 200 ? body : "boom", { status })
  }) as unknown as typeof fetch
}

function collectingSink(): AudioSink & { began: string[]; ended: string[]; aborted: string[]; bytes: number } {
  return {
    began: [], ended: [], aborted: [], bytes: 0,
    begin(id) { this.began.push(id) },
    push(_id, chunk) { this.bytes += chunk.byteLength },
    end(id) { this.ended.push(id) },
    abort(id) { this.aborted.push(id) },
  }
}

describe("DeepgramTts", () => {
  test("yields canonical PCM chunks from a streaming body", async () => {
    const dg = new DeepgramTts({
      apiKey: "k",
      fetchImpl: streamingFetch([new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])]),
    })
    const out: number[] = []
    for await (const c of dg.synthesize("hello")) out.push(...c.pcm)
    expect(out).toEqual([1, 2, 3, 4, 5, 6])
    expect(dg.sampleRate).toBe(24_000)
  })

  test("trims a trailing odd byte to keep whole samples", async () => {
    const dg = new DeepgramTts({ apiKey: "k", fetchImpl: streamingFetch([new Uint8Array([1, 2, 3])]) })
    const out: number[] = []
    for await (const c of dg.synthesize("x")) out.push(...c.pcm)
    expect(out).toEqual([1, 2]) // dropped the half-sample
  })

  test("throws with status on non-200", async () => {
    const dg = new DeepgramTts({ apiKey: "k", fetchImpl: streamingFetch([], 401) })
    await expect((async () => { for await (const _ of dg.synthesize("x")) { /* */ } })())
      .rejects.toThrow(/401/)
  })

  test("empty text yields nothing", async () => {
    const dg = new DeepgramTts({ apiKey: "k", fetchImpl: streamingFetch([new Uint8Array([9])]) })
    const out: number[] = []
    for await (const c of dg.synthesize("   ")) out.push(...c.pcm)
    expect(out).toEqual([])
  })
})

describe("OpenAiTts", () => {
  test("requests pcm + passes instructions through", async () => {
    let captured: any
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      captured = JSON.parse(String(init?.body))
      const body = new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array([7, 8])); c.close() },
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const oa = new OpenAiTts({ apiKey: "k", fetchImpl })
    const out: number[] = []
    for await (const c of oa.synthesize("hi", { instructions: "warm and upbeat" })) out.push(...c.pcm)
    expect(out).toEqual([7, 8])
    expect(captured.response_format).toBe("pcm")
    expect(captured.model).toBe("gpt-4o-mini-tts")
    expect(captured.instructions).toBe("warm and upbeat")
  })
})

describe("ttsFromEnv", () => {
  test("null for apple / unset", () => {
    expect(ttsFromEnv({})).toBeNull()
    expect(ttsFromEnv({ KAIROS_TTS: "apple" })).toBeNull()
  })
  test("builds deepgram when key present", () => {
    const b = ttsFromEnv({ KAIROS_TTS: "deepgram", DEEPGRAM_API_KEY: "k" })
    expect(b?.name).toBe("deepgram")
  })
  test("throws on missing key", () => {
    expect(() => ttsFromEnv({ KAIROS_TTS: "openai" })).toThrow(/OPENAI_API_KEY/)
  })
  test("throws on unknown provider", () => {
    expect(() => ttsFromEnv({ KAIROS_TTS: "elevenlabs" })).toThrow(/unknown/)
  })
})

describe("StreamingTtsBackend", () => {
  test("pumps canonical PCM into the sink and ends cleanly", async () => {
    const dg = new DeepgramTts({ apiKey: "k", fetchImpl: streamingFetch([new Uint8Array([1, 2]), new Uint8Array([3, 4])]) })
    const sink = collectingSink()
    const be = new StreamingTtsBackend(dg, sink)
    await be.speak("hello there")
    expect(sink.began.length).toBe(1)
    expect(sink.ended.length).toBe(1)
    expect(sink.aborted.length).toBe(0)
    expect(sink.bytes).toBe(4)
  })

  test("a provider failure degrades to silence — never throws (no daemon crash)", async () => {
    const dg = new DeepgramTts({ apiKey: "k", fetchImpl: streamingFetch([], 400) })
    const sink = collectingSink()
    const be = new StreamingTtsBackend(dg, sink)
    // Must resolve, not reject — a TTS outage cannot crash the caller.
    await be.speak("hello")
    expect(sink.began.length).toBe(1)
    expect(sink.aborted.length).toBe(1)
    expect(sink.ended.length).toBe(0)
  })

  test("stop() mid-stream aborts the utterance (barge-in)", async () => {
    // A body that never ends until aborted.
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const signal = init?.signal
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (signal?.aborted) { controller.error(new DOMException("aborted", "AbortError")); return }
          await new Promise(r => setTimeout(r, 5))
          controller.enqueue(new Uint8Array([0, 0]))
        },
      })
      return new Response(body, { status: 200 })
    }) as unknown as typeof fetch
    const dg = new DeepgramTts({ apiKey: "k", fetchImpl })
    const sink = collectingSink()
    const be = new StreamingTtsBackend(dg, sink)
    const p = be.speak("a long winded reply")
    await new Promise(r => setTimeout(r, 15))
    be.stop()
    await p
    expect(sink.aborted.length).toBe(1)
    expect(sink.ended.length).toBe(0)
  })
})

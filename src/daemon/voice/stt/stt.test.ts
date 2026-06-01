// src/daemon/voice/stt/stt.test.ts
import { describe, expect, test } from "bun:test"
import { WhisperStt } from "./whisperStt"
import { DeepgramStt } from "./deepgramStt"
import { sttFromEnv } from "./index"

function jsonFetch(body: any, status = 200): typeof fetch {
  return (async () => new Response(status === 200 ? JSON.stringify(body) : "err", { status })) as unknown as typeof fetch
}
const wav = (): { data: Uint8Array; format: "wav" } => ({ data: new Uint8Array([1, 2, 3, 4]), format: "wav" })

describe("WhisperStt", () => {
  test("returns canonical SttResult (final, trimmed)", async () => {
    const stt = new WhisperStt({ name: "groq", baseUrl: "http://x", apiKey: "k", model: "m", fetchImpl: jsonFetch({ text: "  hello there  " }) })
    const r = await stt.transcribe(wav())
    expect(r.text).toBe("hello there")
    expect(r.isFinal).toBe(true)
    expect(stt.sampleRate).toBe(16_000)
  })
  test("throws with status on non-200", async () => {
    const stt = new WhisperStt({ name: "groq", baseUrl: "http://x", apiKey: "k", model: "m", fetchImpl: jsonFetch({}, 401) })
    await expect(stt.transcribe(wav())).rejects.toThrow(/401/)
  })
})

describe("DeepgramStt", () => {
  test("parses Deepgram nested transcript + confidence", async () => {
    const body = { results: { channels: [{ alternatives: [{ transcript: "deep gram", confidence: 0.97 }] }] } }
    const stt = new DeepgramStt({ apiKey: "k", fetchImpl: jsonFetch(body) })
    const r = await stt.transcribe(wav())
    expect(r.text).toBe("deep gram")
    expect(r.confidence).toBeCloseTo(0.97)
    expect(r.isFinal).toBe(true)
  })
})

describe("sttFromEnv", () => {
  test("null for apple / unset", () => {
    expect(sttFromEnv({})).toBeNull()
    expect(sttFromEnv({ KAIROS_STT: "apple" })).toBeNull()
  })
  test("builds groq/openai/deepgram when key present", () => {
    expect(sttFromEnv({ KAIROS_STT: "groq", GROQ_API_KEY: "k" })?.name).toBe("groq")
    expect(sttFromEnv({ KAIROS_STT: "openai", OPENAI_API_KEY: "k" })?.name).toBe("openai")
    expect(sttFromEnv({ KAIROS_STT: "deepgram", DEEPGRAM_API_KEY: "k" })?.name).toBe("deepgram")
  })
  test("throws on missing key", () => {
    expect(() => sttFromEnv({ KAIROS_STT: "groq" })).toThrow(/GROQ_API_KEY/)
  })
  test("throws on unknown provider", () => {
    expect(() => sttFromEnv({ KAIROS_STT: "vosk" })).toThrow(/unknown/)
  })
})

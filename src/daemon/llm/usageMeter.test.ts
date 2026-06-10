// src/daemon/llm/usageMeter.test.ts
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { CostTracker } from "./costTracker"
import { buildLlmUsageHook, buildVoiceUsageHook } from "./usageMeter"

function freshLedger() {
  const db = new Database(":memory:")
  const tracker = new CostTracker(db, 50)
  const rows = () => db.query("SELECT provider, model, task_type, input_tokens, output_tokens, cost_cents FROM llm_call_log").all() as any[]
  return { tracker, rows }
}

test("LLM usage records provider/model/label with a real cost", () => {
  const { tracker, rows } = freshLedger()
  const hook = buildLlmUsageHook(tracker)
  hook({ label: "voice_fast", model: "openai/gpt-4o-mini", tokensIn: 1200, tokensOut: 90, latencyMs: 300 })
  const r = rows()
  expect(r.length).toBe(1)
  expect(r[0].provider).toBe("openrouter")
  expect(r[0].model).toBe("openai/gpt-4o-mini")
  expect(r[0].task_type).toBe("voice_fast")
  expect(r[0].input_tokens).toBe(1200)
  expect(r[0].output_tokens).toBe(90)
  expect(r[0].cost_cents).toBeGreaterThan(0)
  expect(r[0].cost_cents).toBeLessThan(1)   // sub-cent call stays sub-cent (no Math.ceil regression)
})

test("a missing label defaults to 'agent'", () => {
  const { tracker, rows } = freshLedger()
  buildLlmUsageHook(tracker)({ model: "x/y", tokensIn: 10, tokensOut: 5 })
  expect(rows()[0].task_type).toBe("agent")
})

test("a ledger failure is logged, never thrown", () => {
  const logs: string[] = []
  const hook = buildLlmUsageHook({ record: () => { throw new Error("locked") } } as any, (m) => logs.push(m))
  expect(() => hook({ model: "x", tokensIn: 1, tokensOut: 1 })).not.toThrow()
  expect(logs.some((l) => l.includes("locked"))).toBe(true)
})

test("TTS usage costs by chars with the default rate", () => {
  const { tracker, rows } = freshLedger()
  buildVoiceUsageHook(tracker)({ kind: "tts", provider: "deepgram", chars: 2000 })
  const r = rows()[0]
  expect(r.provider).toBe("deepgram")
  expect(r.task_type).toBe("voice_tts")
  expect(r.input_tokens).toBe(2000)
  expect(r.cost_cents).toBeCloseTo(3.0, 5)   // 1.5¢/1k chars × 2k
})

test("STT usage costs by seconds with the default rate", () => {
  const { tracker, rows } = freshLedger()
  buildVoiceUsageHook(tracker)({ kind: "stt", provider: "groq", seconds: 120 })
  const r = rows()[0]
  expect(r.task_type).toBe("voice_stt")
  expect(r.cost_cents).toBeCloseTo(0.86, 5)  // 0.43¢/min × 2min
})

test("voice rates are env-overridable", () => {
  process.env.KAIROS_PRICE_TTS_CENTS_PER_1K_CHARS = "3"
  try {
    const { tracker, rows } = freshLedger()
    buildVoiceUsageHook(tracker)({ kind: "tts", provider: "deepgram", chars: 1000 })
    expect(rows()[0].cost_cents).toBeCloseTo(3.0, 5)
  } finally { delete process.env.KAIROS_PRICE_TTS_CENTS_PER_1K_CHARS }
})

test("zero-unit voice usage records nothing", () => {
  const { tracker, rows } = freshLedger()
  buildVoiceUsageHook(tracker)({ kind: "tts", provider: "deepgram", chars: 0 })
  buildVoiceUsageHook(tracker)({ kind: "stt", provider: "deepgram" })
  expect(rows().length).toBe(0)
})

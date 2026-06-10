// src/daemon/llm/usageMeter.ts
// Daemon-wide usage → ledger hooks. The voice/agent path historically bypassed the
// cost ledger entirely (the conductor tiers, planner, verify gate, compaction,
// distill, and every sub-agent ran on bare OpenRouterAdapter instances) — spend
// tracking was blind to the daemon's biggest spender. These hooks close that gap:
//   • buildLlmUsageHook  — wired to (globalThis).__kairosLlmUsage; the
//     OpenRouterAdapter reports every call here (exact tokens when the provider
//     sent usage, chars/4 estimate otherwise).
//   • buildVoiceUsageHook — wired to (globalThis).__kairosVoiceUsage; STT/TTS
//     adapters report chars/seconds, costed by env-overridable provider rates.
// RECORD-ONLY by design: the voice path is metered but never budget-BLOCKED — a
// spend cap must never mute the assistant mid-sentence. (The proactive subsystem's
// ModelRouter keeps its own enforcement; these hooks don't touch it.)

import { estimateCostCents } from './pricing'
import type { CostRecord } from './costTracker'

export type LlmUsage = {
  label?: string
  model: string
  tokensIn: number
  tokensOut: number
  estimated?: boolean
  latencyMs?: number
}

export type VoiceUsage = {
  kind: 'tts' | 'stt'
  provider: string       // 'deepgram' | 'groq' | 'openai' | …
  chars?: number         // TTS: characters synthesized
  seconds?: number       // STT: audio seconds transcribed
}

// Default provider rates (cents), overridable per deployment:
//   KAIROS_PRICE_TTS_CENTS_PER_1K_CHARS — Deepgram Aura ≈ 1.5–3.0¢/1k chars
//   KAIROS_PRICE_STT_CENTS_PER_MIN     — Deepgram Nova ≈ 0.43¢/min
const ttsCentsPer1k = () => Number(process.env.KAIROS_PRICE_TTS_CENTS_PER_1K_CHARS) || 1.5
const sttCentsPerMin = () => Number(process.env.KAIROS_PRICE_STT_CENTS_PER_MIN) || 0.43

interface Ledger { record(r: CostRecord): void }

export function buildLlmUsageHook(ledger: Ledger, log?: (m: string) => void): (u: LlmUsage) => void {
  return (u) => {
    try {
      const tIn = Math.max(0, Math.round(u.tokensIn) || 0)
      const tOut = Math.max(0, Math.round(u.tokensOut) || 0)
      ledger.record({
        provider: 'openrouter',
        model: u.model,
        task_type: (u.label ?? 'agent') as CostRecord['task_type'],
        input_tokens: tIn,
        output_tokens: tOut,
        cost_cents: estimateCostCents(u.model, tIn, tOut),
        latency_ms: u.latencyMs,
      })
    } catch (e) {
      log?.(`[usage] llm record failed: ${(e as Error).message}`)
    }
  }
}

export function buildVoiceUsageHook(ledger: Ledger, log?: (m: string) => void): (u: VoiceUsage) => void {
  return (u) => {
    try {
      const units = u.kind === 'tts' ? Math.max(0, u.chars ?? 0) : Math.max(0, u.seconds ?? 0)
      if (units === 0) return
      const cents = u.kind === 'tts'
        ? ttsCentsPer1k() * (units / 1000)
        : sttCentsPerMin() * (units / 60)
      ledger.record({
        provider: u.provider as CostRecord['provider'], // TEXT column; 'deepgram'/'groq' are fine
        model: u.kind,
        task_type: u.kind === 'tts' ? 'voice_tts' : 'voice_stt',
        input_tokens: Math.round(units),
        output_tokens: 0,
        cost_cents: cents,
      })
    } catch (e) {
      log?.(`[usage] voice record failed: ${(e as Error).message}`)
    }
  }
}

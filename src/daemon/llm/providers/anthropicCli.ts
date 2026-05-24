// src/daemon/llm/providers/anthropicCli.ts
// Wraps the `claude -p` subprocess so the router can treat it like any
// other provider. Uses the user's Anthropic Pro/Max subscription
// (cost = $0 incremental). Guard against re-entry via KAIROS_SUBPROCESS env.

import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const MODELS_BY_TIER: Record<Tier, string[]> = {
  ultra_cheap: ['claude-haiku-4-5-20251001'],
  mid:         ['claude-sonnet-4-6'],
  heavy:       ['claude-opus-4-7', 'claude-sonnet-4-7'],
}

export class AnthropicCliProvider implements LLMProvider {
  readonly id = 'anthropic_cli' as const

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean { return this.cfg.enabled }

  modelsForTier(tier: Tier): string[] { return MODELS_BY_TIER[tier] }

  pricePerMillion(_model: string): { input: number; output: number } {
    return { input: 0, output: 0 }   // covered by subscription
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    const start = Date.now()

    const args = ['-p', req.prompt, '--model', model, '--output-format', 'json']
    if (req.system) args.push('--append-system-prompt', req.system)

    const proc = Bun.spawn(['claude', ...args], {
      env: { ...process.env, KAIROS_SUBPROCESS: '1' },  // prevent recursion via shim
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) {
      throw new Error(`claude -p exited ${exitCode}: ${stderr.slice(0, 500)}`)
    }

    let text: string
    let parsed: unknown = undefined
    try {
      const obj = JSON.parse(stdout) as { result?: string; usage?: { input_tokens?: number; output_tokens?: number } }
      text = obj.result ?? stdout
      if (req.structured) parsed = tryParseJson(text)
    } catch {
      text = stdout
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: 0,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      input_tokens: Math.ceil(req.prompt.length / 4),
      output_tokens: Math.ceil(text.length / 4),
    }
  }
}

function tryParseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { /* try to extract fenced */ }
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { try { return JSON.parse(fence[1]!) } catch { /* fall through */ } }
  return undefined
}

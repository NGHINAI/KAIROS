// src/daemon/llm/providers/codexCli.ts
// Wraps the `codex exec` subprocess so the router can treat it like any
// other provider. Uses the user's ChatGPT Plus/Pro subscription
// (cost = $0 incremental). Guard against re-entry via KAIROS_SUBPROCESS env.
//
// NOTE: `codex exec --help` was not reachable on this system (the binary is
// installed via npm but the native aarch64 shim is broken — ENOENT).
// Based on the OpenAI Codex CLI README and npm package docs, the invocation
// is:  codex exec "<prompt>" --model <model>
// (positional prompt, --model flag, NOT -m).  detectBinary() spawns a
// lightweight `codex --version` probe; if that fails the adapter marks itself
// unconfigured and the router skips it gracefully.

import type {
  CompletionRequest, CompletionResult, LLMProvider, ProviderConfig, Tier,
} from '../types'

const MODELS_BY_TIER: Record<Tier, string[]> = {
  ultra_cheap: ['gpt-5-mini'],
  mid:         ['gpt-5'],
  heavy:       ['gpt-5-codex'],
}

export class CodexCliProvider implements LLMProvider {
  readonly id = 'codex_cli' as const
  private binaryAvailable: boolean | null = null

  constructor(private cfg: ProviderConfig) {}

  isConfigured(): boolean {
    if (!this.cfg.enabled) return false
    if (this.binaryAvailable === null) {
      this.binaryAvailable = this.detectBinary()
    }
    return this.binaryAvailable
  }

  modelsForTier(tier: Tier): string[] { return MODELS_BY_TIER[tier] }

  pricePerMillion(_model: string): { input: number; output: number } {
    return { input: 0, output: 0 }   // covered by ChatGPT subscription
  }

  async complete(model: string, req: CompletionRequest): Promise<CompletionResult> {
    if (!this.isConfigured()) {
      throw new Error('codex_cli: binary not available or provider disabled')
    }

    const start = Date.now()

    // codex exec takes a positional prompt and --model flag.
    // System prompt is prepended inline since `codex exec` has no --system flag.
    const fullPrompt = req.system ? `${req.system}\n\n${req.prompt}` : req.prompt

    // Invocation: codex exec "<prompt>" --model <model>
    const args = ['exec', fullPrompt, '--model', model]

    const proc = Bun.spawn(['codex', ...args], {
      env: { ...process.env, KAIROS_SUBPROCESS: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if (exitCode !== 0) {
      throw new Error(`codex exec exited ${exitCode}: ${stderr.slice(0, 500)}`)
    }

    const text = stdout.trim()
    let parsed: unknown = undefined
    if (req.structured) {
      try { parsed = JSON.parse(text) } catch {
        const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
        if (fence) { try { parsed = JSON.parse(fence[1]!) } catch { /* leave undefined */ } }
      }
    }

    return {
      text,
      parsed,
      provider: this.id,
      model,
      cost_cents: 0,
      latency_ms: Date.now() - start,
      fallback_count: 0,
      input_tokens: Math.ceil(fullPrompt.length / 4),
      output_tokens: Math.ceil(text.length / 4),
    }
  }

  // Probe by actually spawning the binary, not just `which` — the codex npm
  // wrapper exists on PATH but may fail if the native shim is missing.
  private detectBinary(): boolean {
    try {
      const proc = Bun.spawnSync(['codex', '--version'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return proc.exitCode === 0
    } catch { return false }
  }
}

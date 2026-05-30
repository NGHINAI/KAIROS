// src/daemon/agents/conductor.ts
// Entry point — replaces the legacy handleUserSpeechStreaming.
// For each utterance: classify → route to fast (single LLM) or smart (Planner agent).
//
// E.2.1 ships the skeleton with classifier + fast path only. Smart path
// (full Planner + narrator) lands in E.2.4 (speak-while-acting).

import { classifyIntent } from "./intentClassifier"
import type { AgentEventHandler, ConductorOpts, Tier, ToolDef } from "./types"

interface ContextBuilder {
  build(input: { utterance: string; tier: Tier }): Promise<{ system: string; tools: ToolDef[] }>
}

export interface ConductorDeps {
  classifyLlm: { complete: (body: any) => Promise<{ text: string }> }
  fastLlm:     { complete: (body: any) => Promise<{ text: string }> }
  smartLlm:    { complete: (body: any) => Promise<{ text: string }> }
  tools: ToolDef[]
  contextBuilder: ContextBuilder
  onEvent: AgentEventHandler
}

export class Conductor {
  constructor(private deps: ConductorDeps) {}

  async handle(opts: ConductorOpts): Promise<void> {
    const { utterance, signal } = opts
    if (signal?.aborted) return

    // 1. Classify
    const decision = await classifyIntent(utterance, { llm: this.deps.classifyLlm })
    this.deps.onEvent({ kind: "agent_intent", tier: decision.tier, reason: decision.reason })
    if (signal?.aborted) { this.deps.onEvent({ kind: "agent_interrupted" }); return }

    // 2. Build context for the chosen tier
    const ctx = await this.deps.contextBuilder.build({ utterance, tier: decision.tier })

    // 3. Route
    if (decision.tier === "fast") {
      await this.handleFast(utterance, ctx)
    } else if (decision.tier === "smart") {
      this.deps.onEvent({ kind: "agent_planning", tier: "smart" })
      // Phase E.2.4 will replace this stub with the full Planner + narrator loop.
      await this.handleFast(utterance, ctx)  // fallback for now
    } else if (decision.tier === "vision") {
      // Phase H implementation; for now fall back to fast.
      await this.handleFast(utterance, ctx)
    } else if (decision.tier === "deep") {
      await this.handleFast(utterance, ctx)  // deep LLM swap lands later
    }
  }

  private async handleFast(utterance: string, ctx: { system: string; tools: ToolDef[] }): Promise<void> {
    const resp = await this.deps.fastLlm.complete({
      messages: [
        { role: "system", content: ctx.system },
        { role: "user", content: utterance },
      ],
      max_tokens: 200,
    })
    this.deps.onEvent({ kind: "agent_done", text: String(resp.text ?? "").trim() })
  }
}

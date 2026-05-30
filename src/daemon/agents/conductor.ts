// src/daemon/agents/conductor.ts
// Entry point — replaces the legacy handleUserSpeechStreaming.
// For each utterance: classify → route to fast (single LLM) or smart (Planner agent).
//
// E.2.1 shipped the skeleton with classifier + fast path only. Smart path
// (full Planner + narrator) lands in E.2.4 (speak-while-acting).
// E.2.3 added TrajWriter hook — every turn is appended to the trajectory log.

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
  trajWriter?: { append: (entry: any) => Promise<void> }
}

export class Conductor {
  constructor(private deps: ConductorDeps) {}

  async handle(opts: ConductorOpts): Promise<void> {
    const { utterance, signal } = opts
    const t0 = Date.now()
    let agentOutput = ""
    let intent: { tier: string; reason: string } | undefined

    // Local emit wraps deps.onEvent so we can passively observe events
    // without mutating shared state.
    const emit: AgentEventHandler = (e) => {
      if (e.kind === "agent_done") agentOutput = e.text
      if (e.kind === "agent_intent") intent = { tier: e.tier, reason: e.reason }
      this.deps.onEvent(e)
    }

    try {
      if (signal?.aborted) return

      // 1. Classify
      const decision = await classifyIntent(utterance, { llm: this.deps.classifyLlm })
      emit({ kind: "agent_intent", tier: decision.tier, reason: decision.reason })
      if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }

      // 2. Build context for the chosen tier
      const ctx = await this.deps.contextBuilder.build({ utterance, tier: decision.tier })

      // 3. Route
      if (decision.tier === "fast") {
        await this.handleFast(utterance, ctx, emit)
      } else if (decision.tier === "smart") {
        emit({ kind: "agent_planning", tier: "smart" })
        // Phase E.2.4 will replace this stub with the full Planner + narrator loop.
        await this.handleFast(utterance, ctx, emit)  // fallback for now
      } else if (decision.tier === "vision") {
        // Phase H implementation; for now fall back to fast.
        await this.handleFast(utterance, ctx, emit)
      } else if (decision.tier === "deep") {
        await this.handleFast(utterance, ctx, emit)  // deep LLM swap lands later
      }
    } finally {
      if (this.deps.trajWriter) {
        try {
          await this.deps.trajWriter.append({
            user_input: opts.utterance,
            intent_tier: intent?.tier ?? "unknown",
            intent_reason: intent?.reason ?? "",
            agent_output: agentOutput,
            latency_ms: Date.now() - t0,
            conversation_id: opts.conversationId,
            at: t0,
          })
        } catch {
          // Don't let traj write failure break the turn.
        }
      }
    }
  }

  private async handleFast(
    utterance: string,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
  ): Promise<void> {
    const resp = await this.deps.fastLlm.complete({
      messages: [
        { role: "system", content: ctx.system },
        { role: "user", content: utterance },
      ],
      max_tokens: 200,
    })
    emit({ kind: "agent_done", text: String(resp.text ?? "").trim() })
  }
}

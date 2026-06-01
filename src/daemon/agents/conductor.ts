// src/daemon/agents/conductor.ts
// Entry point — replaces the legacy handleUserSpeechStreaming.
// For each utterance: classify → route to fast (single LLM) or smart (Planner agent).
//
// E.2.1 shipped the skeleton with classifier + fast path only.
// E.2.3 added TrajWriter hook — every turn is appended to the trajectory log.
// E.2.4 wires the smart path through the Planner agent + Narrator for
// synchronous speak-while-acting narration during multi-step work.

import { classifyIntent } from "./intentClassifier"
import { Narrator } from "./narrator"
import { fastMax } from "./tokenBudget"
import type { AgentEventHandler, ConductorOpts, Tier, ToolDef } from "./types"

interface ContextBuilder {
  build(input: { utterance: string; tier: Tier; conversationId?: string }): Promise<{ system: string; tools: ToolDef[] }>
}

/** Runs the Planner agent and returns a flattened summary of the run.
 *  Injected so tests can stub the heavy SDK invocation. */
export interface PlannerRunner {
  (input: string, opts: { tools: ToolDef[]; instructions: string; signal?: AbortSignal }): Promise<{
    finalOutput: string
    toolCalls: Array<{ id: string; name: string; args: any; result?: any; error?: string }>
  }>
}

export interface ConductorDeps {
  classifyLlm: { complete: (body: any) => Promise<{ text: string }> }
  fastLlm:     { complete: (body: any) => Promise<{ text: string }> }
  smartLlm:    { complete: (body: any) => Promise<{ text: string }> }
  tools: ToolDef[]
  contextBuilder: ContextBuilder
  onEvent: AgentEventHandler
  trajWriter?: { append: (entry: any) => Promise<void> }
  runPlanner?: PlannerRunner
  speakBackend?: { speak: (text: string) => Promise<void> }
  personaTone?: string
}

export class Conductor {
  constructor(private deps: ConductorDeps) {}

  async handle(opts: ConductorOpts): Promise<void> {
    const { utterance, signal, conversationId } = opts
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
      console.log(`[conductor] handle ENTER: utterance="${utterance.slice(0, 80)}"`)
      if (signal?.aborted) { console.log('[conductor] aborted before classify'); emit({ kind: "agent_interrupted" }); return }

      // 1. Classify
      const decision = await classifyIntent(utterance, { llm: this.deps.classifyLlm })
      console.log(`[conductor] classified: tier=${decision.tier} reason="${decision.reason}" confidence=${decision.confidence}`)
      emit({ kind: "agent_intent", tier: decision.tier, reason: decision.reason })
      if (signal?.aborted) { console.log('[conductor] aborted after classify'); emit({ kind: "agent_interrupted" }); return }

      // 2. Build context for the chosen tier. Pass conversationId so the builder
      // injects recent turns + relevant memory (without it, build() returns only
      // the static prefix → the agent has no short-term memory of the conversation).
      const ctx = await this.deps.contextBuilder.build({ utterance, tier: decision.tier, conversationId })
      console.log(`[conductor] context built: system.length=${ctx.system.length} tools=${ctx.tools.length}`)
      if (signal?.aborted) { console.log('[conductor] aborted after context'); emit({ kind: "agent_interrupted" }); return }

      // 3. Route
      if (decision.tier === "fast") {
        console.log('[conductor] -> handleFast')
        await this.handleFast(utterance, ctx, emit)
      } else if (decision.tier === "smart") {
        console.log('[conductor] -> handleSmart')
        await this.handleSmart(opts, ctx, emit)
      } else if (decision.tier === "vision") {
        console.log('[conductor] -> vision (fallback to fast)')
        await this.handleFast(utterance, ctx, emit)
      } else if (decision.tier === "deep") {
        console.log('[conductor] -> deep (fallback to fast)')
        await this.handleFast(utterance, ctx, emit)
      } else {
        console.log(`[conductor] !!! unknown tier "${decision.tier}" — no handler fired`)
      }

      // Speak the final reply through TTS. handleFast emits agent_done but
      // doesn't speak; handleSmart narrates tool progress but doesn't speak
      // the final answer. We do that here once, in a single place, so both
      // tiers behave consistently.
      if (agentOutput && !signal?.aborted && this.deps.speakBackend) {
        console.log(`[conductor] speaking final reply (${agentOutput.length} chars): "${agentOutput.slice(0, 80)}"`)
        try {
          await this.deps.speakBackend.speak(agentOutput)
          console.log(`[conductor] speak complete`)
        } catch (err) {
          console.log(`[conductor] speak error: ${(err as Error).message}`)
        }
      } else if (!agentOutput) {
        console.log(`[conductor] no agentOutput — nothing to speak`)
      }

      console.log('[conductor] handle EXIT (normal)')
    } catch (e) {
      console.log(`[conductor] handle THREW: ${(e as Error).message}\n${(e as Error).stack ?? ''}`)
      throw e
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
      max_tokens: fastMax(200),  // floor via KAIROS_FAST_MAX_TOKENS for reasoning models
    })
    emit({ kind: "agent_done", text: String(resp.text ?? "").trim() })
  }

  private async handleSmart(
    opts: ConductorOpts,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
  ): Promise<void> {
    emit({ kind: "agent_planning", tier: "smart" })

    const narrator = this.deps.speakBackend
      ? new Narrator({
          fastLlm: this.deps.fastLlm,
          speakBackend: this.deps.speakBackend,
          personaTone: this.deps.personaTone,
        })
      : undefined

    const runFn = this.deps.runPlanner ?? defaultPlannerRunner
    const result = await runFn(opts.utterance, {
      tools: ctx.tools,
      instructions: ctx.system,
      signal: opts.signal,
    })

    for (const tc of result.toolCalls) {
      emit({ kind: "agent_tool_call", name: tc.name, args: tc.args, id: tc.id })
      if (narrator) await narrator.speakAck(tc.name)
      if (tc.error) {
        emit({ kind: "agent_tool_failed", name: tc.name, id: tc.id, error: tc.error })
      } else {
        emit({
          kind: "agent_tool_done",
          name: tc.name,
          id: tc.id,
          result_summary: summarize(tc.result),
        })
        if (narrator) await narrator.speakTransition(tc.name, tc.result)
      }
    }

    emit({ kind: "agent_done", text: result.finalOutput })
  }
}

/** Default planner runner — dynamically imports @openai/agents + buildPlannerAgent
 *  so test stubs can inject `runPlanner` without paying the SDK boot cost. */
async function defaultPlannerRunner(
  input: string,
  opts: { tools: ToolDef[]; instructions: string; signal?: AbortSignal },
): Promise<{
  finalOutput: string
  toolCalls: Array<{ id: string; name: string; args: any; result?: any; error?: string }>
}> {
  const { run } = await import("@openai/agents")
  const { buildPlannerAgent } = await import("./plannerAgent")
  const agent = buildPlannerAgent({ instructions: opts.instructions, tools: opts.tools })
  const result: any = await run(agent, input)
  return {
    finalOutput: result?.finalOutput ?? "",
    toolCalls: extractToolCalls(result),
  }
}

/** Best-effort tool-call extraction from an @openai/agents RunResult.
 *  The SDK doesn't expose a stable shape across versions — we walk common
 *  shapes (children / steps / events) and collect anything that smells like
 *  a tool_call node. Returns [] on any miss; callers must tolerate that. */
function extractToolCalls(
  result: any,
): Array<{ id: string; name: string; args: any; result?: any; error?: string }> {
  const calls: Array<{ id: string; name: string; args: any; result?: any; error?: string }> = []
  const traverse = (node: any): void => {
    if (!node || typeof node !== "object") return
    if (node.type === "tool_call" || node.kind === "tool_call") {
      calls.push({
        id: node.id ?? `t${calls.length}`,
        name: node.name ?? node.tool,
        args: node.arguments ?? node.args,
        result: node.output ?? node.result,
        error: node.error,
      })
    }
    if (Array.isArray(node.children)) node.children.forEach(traverse)
    if (Array.isArray(node.steps)) node.steps.forEach(traverse)
    if (Array.isArray(node.events)) node.events.forEach(traverse)
  }
  traverse(result)
  return calls
}

/** Shorten an arbitrary tool result for the wire / log surface.
 *  Cuts to 200 chars and appends an ellipsis on truncation. */
function summarize(result: any): string {
  if (result == null) return "(no result)"
  if (typeof result === "string") return result.slice(0, 200)
  const s = JSON.stringify(result)
  return s.length > 200 ? s.slice(0, 200) + "..." : s
}

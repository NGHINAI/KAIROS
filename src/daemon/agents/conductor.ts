// src/daemon/agents/conductor.ts
// Entry point — replaces the legacy handleUserSpeechStreaming.
// For each utterance: classify → route to fast (single LLM) or smart (Planner agent).
//
// E.2.1 shipped the skeleton with classifier + fast path only.
// E.2.3 added TrajWriter hook — every turn is appended to the trajectory log.
// E.2.4 wires the smart path through the Planner agent + Narrator for
// synchronous speak-while-acting narration during multi-step work.

import { classifyIntent } from "./intentClassifier"
import { fastMax } from "./tokenBudget"
import { StreamSpeechController, type SpeakSink } from "./streamSpeechController"
import { pickAck, pickFiller, describeAction } from "./fillerBank"
import { isDestructiveCall } from "./loop/verifier"
import type { AgentEventHandler, ConductorOpts, Tier, ToolDef } from "./types"
import type { LoopEvent } from "./loop/types"

interface ContextBuilder {
  build(input: { utterance: string; tier: Tier; conversationId?: string }): Promise<{ system: string; tools: ToolDef[] }>
}

/** Runs the Planner agent and returns a flattened summary of the run.
 *  Injected so tests can stub the heavy SDK invocation. `onEvent` streams live
 *  loop events (deltas, tool starts) so the conductor can speak as it generates. */
export interface PlannerRunner {
  (input: string, opts: { tools: ToolDef[]; instructions: string; signal?: AbortSignal; onEvent?: (e: LoopEvent) => void }): Promise<{
    finalOutput: string
    /** The model's raw final answer that was STREAMED live (pre-verify-gate).
     *  If finalOutput differs, the verify-gate corrected it → speak a follow-up. */
    streamedText?: string
    /** True if the in-loop verify gate flagged the first answer and self-corrected. */
    corrected?: boolean
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
  /** Observability: records every turn (utterance, tier, tool calls, reply) to a
   *  human-readable + JSONL log so actions can be verified and leaks flagged. */
  turnLogger?: { record: (entry: any) => void }
  runPlanner?: PlannerRunner
  speakBackend?: { speak: (text: string) => Promise<void> }
  /** Incremental speaker (StreamingSpeaker) for live token-by-token streaming on
   *  the smart tier. When present, the smart answer is spoken AS IT GENERATES
   *  (no dead air); when absent, the smart tier falls back to speak-at-end. */
  streamSink?: SpeakSink
  personaTone?: string
  /** Recent turns for the ROUTER — lets the classifier resolve short replies
   *  ("yes", "do it", "the second one") against what KAIROS just said. */
  conversationStore?: { recentTurns: (id: string, n: number) => Promise<Array<{ role: string; text: string }>> }
}

export class Conductor {
  constructor(private deps: ConductorDeps) {}

  async handle(opts: ConductorOpts): Promise<void> {
    const { utterance, signal, conversationId } = opts
    const t0 = Date.now()
    let agentOutput = ""
    let intent: { tier: string; reason: string } | undefined
    const toolCalls: Array<{ id?: string; name: string; args?: any; result?: string; error?: string }> = []

    // Local emit wraps deps.onEvent so we can passively observe events
    // without mutating shared state.
    const emit: AgentEventHandler = (e) => {
      if (e.kind === "agent_done") agentOutput = e.text
      if (e.kind === "agent_intent") intent = { tier: e.tier, reason: e.reason }
      if (e.kind === "agent_tool_call") toolCalls.push({ id: (e as any).id, name: e.name, args: (e as any).args })
      if (e.kind === "agent_tool_done") { const tc = toolCalls.find((t) => t.id === (e as any).id); if (tc) tc.result = (e as any).result_summary }
      if (e.kind === "agent_tool_failed") { const tc = toolCalls.find((t) => t.id === (e as any).id); if (tc) tc.error = (e as any).error }
      this.deps.onEvent(e)
    }

    try {
      console.log(`[conductor] handle ENTER: utterance="${utterance.slice(0, 80)}"`)
      if (signal?.aborted) { console.log('[conductor] aborted before classify'); emit({ kind: "agent_interrupted" }); return }

      // 1. Classify — give the router recent context so short replies ("yes",
      // "do it") route to the tier the pending action needs, not a blind "fast".
      let recentContext: string | undefined
      if (this.deps.conversationStore && conversationId) {
        try {
          const turns = await this.deps.conversationStore.recentTurns(conversationId, 2)
          if (turns.length > 0) {
            recentContext = turns.map((t) => `${t.role === "agent" ? "KAIROS" : "user"}: ${t.text}`).join("\n")
          }
        } catch { /* router context is best-effort */ }
      }
      const decision = await classifyIntent(utterance, { llm: this.deps.classifyLlm, recentContext })
      console.log(`[conductor] classified: tier=${decision.tier} reason="${decision.reason}" confidence=${decision.confidence}`)
      emit({ kind: "agent_intent", tier: decision.tier, reason: decision.reason })
      if (signal?.aborted) { console.log('[conductor] aborted after classify'); emit({ kind: "agent_interrupted" }); return }

      // 2. Build context for the chosen tier. Pass conversationId so the builder
      // injects recent turns + relevant memory (without it, build() returns only
      // the static prefix → the agent has no short-term memory of the conversation).
      const ctx = await this.deps.contextBuilder.build({ utterance, tier: decision.tier, conversationId })
      console.log(`[conductor] context built: system.length=${ctx.system.length} tools=${ctx.tools.length}`)
      if (signal?.aborted) { console.log('[conductor] aborted after context'); emit({ kind: "agent_interrupted" }); return }

      // 3. Route. Each handler now owns its own SPEAKING (fast: speak-at-end;
      // smart: live streaming via the StreamSpeechController) so the smart tier
      // can talk as it generates instead of dead-air-then-dump.
      if (decision.tier === "fast") {
        console.log('[conductor] -> handleFast')
        await this.handleFast(utterance, ctx, emit, signal)
      } else if (decision.tier === "smart") {
        console.log('[conductor] -> handleSmart')
        await this.handleSmart(opts, ctx, emit)
      } else if (decision.tier === "vision") {
        // Vision/screen tasks need tools (screenshot, computer-use) → the planner,
        // NOT the tool-less fast path (which would hallucinate about the screen).
        console.log('[conductor] -> vision (route to smart/planner)')
        await this.handleSmart(opts, ctx, emit)
      } else if (decision.tier === "deep") {
        // Deep = hard multi-step reasoning → the tool-capable planner.
        console.log('[conductor] -> deep (route to smart/planner)')
        await this.handleSmart(opts, ctx, emit)
      } else {
        console.log(`[conductor] !!! unknown tier "${decision.tier}" — no handler fired`)
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
      // Observability: log the full turn (utterance, tier, tools actually called,
      // reply) so actions can be verified and tool-call leaks flagged.
      if (this.deps.turnLogger) {
        try {
          this.deps.turnLogger.record({
            at: t0,
            conversationId: opts.conversationId,
            utterance: opts.utterance,
            tier: intent?.tier,
            toolCalls,
            reply: agentOutput,
          })
        } catch { /* logging must never break a turn */ }
      }
    }
  }

  private async handleFast(
    utterance: string,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
    signal?: AbortSignal,
  ): Promise<void> {
    const resp = await this.deps.fastLlm.complete({
      messages: [
        { role: "system", content: ctx.system },
        { role: "user", content: utterance },
      ],
      max_tokens: fastMax(200),  // floor via KAIROS_FAST_MAX_TOKENS for reasoning models
    })
    // Reasoning models (gpt-oss, nemotron) can burn the whole token budget in
    // their `reasoning` field and return EMPTY content → a silent turn. Never go
    // silent: fall back to a short spoken prompt so the user always hears something.
    const text = sanitizeReply(resp.text) || "Sorry, I didn't catch that — could you say it again?"
    emit({ kind: "agent_done", text })
    // Fast path is a single quick completion → speak it whole (no dead air to fill).
    if (this.deps.speakBackend && !signal?.aborted) {
      try { await this.deps.speakBackend.speak(text) } catch (err) { console.log(`[conductor] fast speak error: ${(err as Error).message}`) }
    }
  }

  private async handleSmart(
    opts: ConductorOpts,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
  ): Promise<void> {
    emit({ kind: "agent_planning", tier: "smart" })

    // Live streaming controller — feeds the answer to the speaker AS IT GENERATES
    // and feeds a short "on it…" ack INLINE the instant a (non-instant) tool starts.
    // This is the dead-air killer. Absent a stream sink (tests) we speak-at-end.
    const controller = this.deps.streamSink
      ? new StreamSpeechController({
          speaker: this.deps.streamSink,
          // Instant, tool-aware, non-repeating, character-flavored acks + fillers
          // (fillerBank) — no LLM latency, so they actually kill the dead air.
          ackPhrase: (name, args) => pickAck(name, args),
          fillerPhrase: (lastTool) => pickFiller(lastTool ? describeAction(lastTool.name, lastTool.args).noun : undefined),
          fillerMs: Number(process.env.KAIROS_FILLER_MS) || 7000,
          // "Block writes": withhold the live final claim once an irreversible tool
          // fires; we speak the verify-gate's confirmed final at the end instead.
          isDestructive: (name, args) => isDestructiveCall({ name, args }),
        })
      : undefined
    controller?.begin()

    // Barge-in / supersede cancels the run's signal but is wired only to abort the
    // loop + stop the shared speaker — NOT this controller (a local). Without this,
    // a re-armed filler timer from an aborted slow-tool turn could fire its "still on
    // it" into the NEXT turn's audio (shared speaker). Cancel the controller on abort
    // so its filler timer becomes a no-op. Listener is removed after the run.
    const onAbort = () => { try { controller?.cancel() } catch { /* */ } }
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener?.("abort", onAbort, { once: true })

    // Stable id for THIS foreground turn — root of the activity tree (Lane A). Any
    // background sub-agent spawned this turn links to it via parentRunId (set on the
    // manager by handleUtterance). Provided by index.ts; fallback for tests.
    const runId = opts.runId ?? `turn_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const activity = (kind: string, extra: Record<string, unknown> = {}) =>
      emit({ kind: "agent_activity", activity: { runId, parentRunId: null, depth: 0, lane: "A", conversationId: opts.conversationId, kind, ts: Date.now(), ...extra } })

    // Route every loop event to live speech (controller), the live UI (flat agent_*),
    // AND the unified activity tree (agent_activity envelope) + delta/plan/status.
    const onEvent = (e: LoopEvent) => {
      controller?.handle(e)
      if (e.kind === "tool_call_start") {
        emit({ kind: "agent_tool_call", name: e.name, args: e.args, id: e.id })
        activity("tool_call", { tool: e.name, status: "running" })
        const status = humanStatus(e.name, e.args)
        if (status) emit({ kind: "agent_status", text: status })
      } else if (e.kind === "tool_call_done") {
        emit({ kind: "agent_tool_done", name: e.name, id: e.id, result_summary: summarize(e.result) })
        activity("tool_done", { tool: e.name, status: "done", summary: summarize(e.result) })
      } else if (e.kind === "tool_call_failed") {
        emit({ kind: "agent_tool_failed", name: e.name, id: e.id, error: e.error })
        activity("tool_failed", { tool: e.name, status: "failed", summary: e.error })
      } else if (e.kind === "assistant_delta") {
        emit({ kind: "agent_delta", text: e.text }) // token stream → UI captions
      } else if (e.kind === "plan_update") {
        emit({ kind: "agent_plan", steps: e.plan })
        activity("plan_update", { summary: planSummary(e.plan) })
      } else if (e.kind === "compaction") {
        activity("compaction")
      } else if (e.kind === "self_correct") {
        // The grounded-verify gate flagged the draft answer; KAIROS is re-checking
        // before it speaks. Surface it both as a live caption and on the activity
        // tree so the HUD can show a "double-checking…" beat instead of silence.
        emit({ kind: "agent_status", text: "let me double-check that…" })
        activity("self_correct", { status: "running", summary: e.concern })
      }
    }
    activity("planning") // root node appears the moment the turn starts working

    const runFn = this.deps.runPlanner ?? defaultPlannerRunner
    const result = await runFn(opts.utterance, {
      tools: ctx.tools,
      instructions: ctx.system,
      signal: opts.signal,
      onEvent,
    })

    try { opts.signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
    await controller?.finish()

    const reply = sanitizeReply(result.finalOutput) || "I wasn't able to finish that — want me to try again?"

    if (controller) {
      if (controller.suppressedFinal()) {
        // WRITE turn: the live final claim was held back until the verify gate ran.
        // Speak the VERIFIED final now — so KAIROS never voiced "done, deleted"
        // before confirming it actually happened. This is the ~300ms "block" the
        // user only pays on irreversible actions.
        if (this.deps.speakBackend && !opts.signal?.aborted && reply) {
          try { await this.deps.speakBackend.speak(reply) } catch { /* */ }
        }
      } else {
        // READ turn: the answer streamed live during the run (self-corrections, if
        // any, also streamed live as a natural "—actually…"). Speak a follow-up
        // ONLY if the verified final still diverged from what was streamed.
        const streamed = sanitizeReply(result.streamedText ?? "")
        if (this.deps.speakBackend && !opts.signal?.aborted && reply && reply !== streamed) {
          try { await this.deps.speakBackend.speak(reply) } catch { /* */ }
        }
      }
    } else if (this.deps.speakBackend && !opts.signal?.aborted) {
      // No streaming sink → speak the whole reply at the end (fallback path).
      try { await this.deps.speakBackend.speak(reply) } catch (err) { console.log(`[conductor] smart speak error: ${(err as Error).message}`) }
    }

    emit({ kind: "agent_done", text: reply })
  }
}

// Raw tool-call markup that must NEVER be spoken. Some models (e.g. Kimi K2 via
// certain providers) emit tool calls as TEXT instead of structured calls; that
// markup must never reach TTS. If detected, we speak a recovery line instead.
const TOOL_MARKUP_RE = /<tool_call|tool_calls_section|<\|tool|functions\.[a-zA-Z_]+\s*[\{<]/

// Reasoning models wrap their chain-of-thought in <think>/<thinking>/<reasoning>
// tags — that internal monologue must NEVER be spoken. Strip the tagged blocks (and
// any dangling open tag) before TTS. (The real fix for CoT leakage is a non-reasoning
// SMART model — see TIER_MODELS.smart — but this catches a tagged model defensively.)
const THINK_BLOCK_RE = /<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi
const THINK_DANGLING_RE = /<(think|thinking|reasoning|thought)>[\s\S]*$/i

function sanitizeReply(text: unknown): string {
  let t = String(text ?? "").replace(THINK_BLOCK_RE, " ").replace(THINK_DANGLING_RE, " ").trim()
  if (!t) return ""
  if (TOOL_MARKUP_RE.test(t)) return "Sorry, I hit a snag running that — let me try again in a moment."
  return t
}

/** Default planner runner — drives the KAIROS Agent Loop (our owned, Codex-grade
 *  loop) on the streaming OpenRouter adapter with the SMART-tier model. Replaces
 *  the old @openai/agents run() so we get tool-error self-correction, max-turns,
 *  empty-output guard, and (Phase 3) live narration. Same return shape as before
 *  so handleSmart and the conductor tests are unaffected. */
async function defaultPlannerRunner(
  input: string,
  opts: { tools: ToolDef[]; instructions: string; signal?: AbortSignal; onEvent?: (e: LoopEvent) => void },
): Promise<{
  finalOutput: string
  streamedText?: string
  corrected?: boolean
  toolCalls: Array<{ id: string; name: string; args: any; result?: any; error?: string }>
}> {
  const { OpenRouterAdapter } = await import("../wrapApi/adapters/openRouterAdapter")
  const { runAgentLoop } = await import("./loop/agentLoop")
  const { buildCompactor, COMPACT_PROMPT } = await import("./loop/compactor")
  const { buildUpdatePlanTool } = await import("./loop/updatePlanTool")
  const { buildDestructiveVerifier } = await import("./loop/verifier")
  const { TIER_MODELS, verifyModel } = await import("./types")

  // Generous token budget: a reasoning SMART model (kimi-k2.5/minimax) spends tokens
  // on its (excluded) chain-of-thought, so a 512 default left no room for the actual
  // answer → empty reply. The spoken answer stays short (the prompt enforces brevity);
  // this headroom is for the hidden reasoning. Tune with KAIROS_SMART_MAX_TOKENS.
  const smart = new OpenRouterAdapter({
    defaultModel: TIER_MODELS.smart(),
    defaultMaxTokens: Number(process.env.KAIROS_SMART_MAX_TOKENS) || 4096,
  })
  // Cheap model for compaction summaries.
  const fast = new OpenRouterAdapter({ defaultModel: process.env.KAIROS_MEMORY_MODEL ?? TIER_MODELS.fast() })
  // SEPARATE, more-capable model for the grounding verify gate (the anti-hallucination
  // judge) — a sharper reader catches the subtle misreads gpt-4o-mini lets slide.
  const verify = new OpenRouterAdapter({ defaultModel: verifyModel() })

  // Context compaction — summarize-and-replace when a long multi-tool task grows.
  const compactor = buildCompactor({
    summarize: async (msgs) => {
      const transcript = msgs
        .map((m: any) => `${m.role}: ${m.content ?? (m.tool_calls ? "[requested tools]" : "")}`)
        .join("\n")
        .slice(0, 40000)
      const r = await fast.complete({
        messages: [{ role: "system", content: COMPACT_PROMPT }, { role: "user", content: transcript }],
        max_tokens: 512,
      })
      return r.text
    },
  })

  // update_plan is a loop-scoped scratchpad tool (kept out of the action toolset).
  const tools = [...opts.tools, buildUpdatePlanTool({})]

  // Grounded verify gate, run INSIDE the loop (see runAgentLoop): before any
  // tool-using turn's answer stands, a capable judge (verifyModel) checks the claim
  // is supported by the FULL tool ledger. On a flag the loop self-corrects — it
  // restates from the results rather than letting KAIROS speak something the tools
  // never did. General: catches a phantom action ("Deleted" with no delete call)
  // AND a misread ("last email is X" when the fetch returned Y), with no verb lists.
  const verifier = buildDestructiveVerifier({ llm: { complete: (b: any) => verify.complete(b) } })

  const res = await runAgentLoop(
    [
      { role: "system", content: opts.instructions },
      { role: "user", content: input },
    ],
    {
      llm: smart as unknown as import("./loop/types").LoopLlm,
      tools,
      signal: opts.signal,
      onEvent: opts.onEvent,          // live streaming → the conductor speaks as it generates
      compact: (m, t) => compactor.maybeCompact(m, t),
      verify: (o) => verifier.verify({ utterance: input, finalText: o.finalText, toolCalls: o.toolCalls }),
    },
  )

  // res.finalText is already verified/corrected by the in-loop gate.
  let finalOutput = res.finalText

  // Empty-output recovery: if the model ran a tool that already produced a complete,
  // user-facing STRING answer and then said nothing (common with fire-and-forget
  // tools like spawn_background_task), speak that result instead of the generic
  // "I wasn't able to finish that" — the action succeeded; saying it failed is a lie.
  if (!finalOutput.trim()) {
    const lastStr = [...res.toolCalls].reverse().find((c) => typeof c.result === "string" && String(c.result).trim())
    if (lastStr) finalOutput = String(lastStr.result)
  }

  return {
    finalOutput,
    streamedText: res.finalText,
    corrected: res.corrected,
    toolCalls: res.toolCalls.map((c, i) => ({ id: `t${i}`, name: c.name, args: c.args, result: c.result, error: c.error })),
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

/** A short, human status line for the UI ("Working on your Gmail"). "" = skip. */
function humanStatus(name: string, args: any): string {
  if (name === "search_tools" || name === "update_plan" || name === "background_tasks") return ""
  try {
    const d = describeAction(name, args)
    return d.noun && d.noun !== "that" ? `Working on ${d.noun}${d.target}` : ""
  } catch { return "" }
}

/** A one-line plan summary for the activity envelope ("step 2 of 3: …"). */
function planSummary(plan: Array<{ step: string; status: string }> | undefined): string {
  if (!plan || plan.length === 0) return ""
  const done = plan.filter((s) => s.status === "completed").length
  const cur = plan.find((s) => s.status === "in_progress") ?? plan.find((s) => s.status === "pending")
  return cur ? `step ${Math.min(done + 1, plan.length)} of ${plan.length}: ${cur.step}` : `${done} of ${plan.length} done`
}

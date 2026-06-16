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
import { isDestructiveCall, DO_ASK_RE, TEACHING_RE as TEACH_ASK_RE, GUIDE_RE } from "./loop/verifier"
import { sanitizeSpoken, SpokenStreamFilter } from "./spokenSanitizer"
import type { AgentEventHandler, ConductorOpts, Tier, ToolDef } from "./types"
import type { LoopEvent, LoopMsg } from "./loop/types"

interface ContextBuilder {
  build(input: { utterance: string; tier: Tier; conversationId?: string }): Promise<{ system: string; tools: ToolDef[] }>
}

/** Runs the Planner agent and returns a flattened summary of the run.
 *  Injected so tests can stub the heavy SDK invocation. `onEvent` streams live
 *  loop events (deltas, tool starts) so the conductor can speak as it generates. */
export interface PlannerRunner {
  (input: string, opts: {
    tools: ToolDef[]
    instructions: string
    signal?: AbortSignal
    onEvent?: (e: LoopEvent) => void
    /** Durable conversation history (real messages incl. prior tool results) replayed
     *  before the user turn so the model can chain off what it already did (e.g. a
     *  gmail threadId from an earlier send). Empty/omitted = no replay. */
    history?: LoopMsg[]
    /** DYNAMIC per-task reasoning effort chosen by the router. The brain maps it to a
     *  per-turn proxy alias (kairos-<effort>) → reasoning budget, and auto-escalates to
     *  high on failure. Omitted = the brain's env-default lane. */
    effort?: "low" | "medium" | "high"
    /** Which dispatch lane this task belongs to, read by the BrainRouter to pick an
     *  engine: "voice" (interactive/guidance → in-house) vs "background" (autonomous/
     *  long-running → opencode). Omitted = "voice". */
    lane?: "voice" | "background"
  }): Promise<{
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
  /** Deep/thinking model for the [[think]] route (sync hard reasoning, time-capped).
   *  Absent → [[think]] falls back to the planner. */
  thinkLlm?:   { complete: (body: any) => Promise<{ text: string }> }
  /** STREAMING deep-tier completer for [[think]] (OpenRouterAdapter.stream-shaped).
   *  When present (and streamSink is wired), think answers stream sentence-by-sentence
   *  to the speaker — the whole-answer cap becomes a FIRST-TOKEN deadline, so hard
   *  questions get answered LIVE instead of converting to background. The body gets a
   *  `signal` for cancellation. Absent → the blocking time-capped path. */
  thinkStream?: (body: any) => AsyncIterable<{ kind: string; text?: string; message?: string }>
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
  /** Durable full-message transcript (incl. tool results). When present, the smart
   *  tier loads a bounded, tool-pair-safe replay of prior turns to seed the planner,
   *  and persists each turn after it runs. This is what lets a later turn reuse an id
   *  (gmail threadId, issue id, file path) from an action it already took. */
  conversationMessages?: {
    loadForReplay: (conversationId: string, opts?: { maxTurns?: number; maxChars?: number }) => Promise<LoopMsg[]>
    appendTurn: (conversationId: string, turnId: string, msgs: LoopMsg[]) => Promise<void>
    /** Off-hot-path: fold turns older than the recent window into a rolling summary so
     *  the whole conversation is remembered (recent verbatim + older summarized). */
    updateRollingSummary?: (conversationId: string, summarize: (text: string) => Promise<string>, opts?: { keepRecent?: number }) => Promise<void>
  }
  /** Durable activity log — records WHAT KAIROS DID per turn so it can later answer
   *  "what did you do yesterday". Only action/tool turns are recorded (chitchat skipped). */
  activity?: { record: (ev: { at: number; kind: string; lane: "foreground"; title: string; detail?: string; tool?: string; status?: string; importance?: number; conversationId?: string; ref?: Record<string, unknown> }) => void }
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
      if (signal?.aborted) { console.log('[conductor] aborted before route'); emit({ kind: "agent_interrupted" }); return }

      // FAST-FRONT (default): the fast model IS the router — it answers chit-chat directly or
      // routes via a [[task]]/[[think]] directive. The pre-classifier LLM call is out of the hot
      // path. KAIROS_CLASSIC_ROUTER=1 restores the old classify→route flow.
      if (process.env.KAIROS_CLASSIC_ROUTER === "1") {
        await this.classicFlow(opts, emit)
      } else {
        await this.frontFlow(opts, emit)
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

  /** LEGACY router: classify with a separate LLM call, then route by tier. Kept behind
   *  KAIROS_CLASSIC_ROUTER=1 as the escape hatch for the fast-front collapse. */
  private async classicFlow(opts: ConductorOpts, emit: AgentEventHandler): Promise<void> {
    const { utterance, signal, conversationId } = opts
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

    const ctx = await this.deps.contextBuilder.build({ utterance, tier: decision.tier, conversationId })
    console.log(`[conductor] context built: system.length=${ctx.system.length} tools=${ctx.tools.length}`)
    if (signal?.aborted) { console.log('[conductor] aborted after context'); emit({ kind: "agent_interrupted" }); return }

    if (decision.tier === "fast") {
      console.log('[conductor] -> handleFast')
      await this.handleFast(utterance, ctx, emit, signal, conversationId)
    } else {
      // smart / vision / deep all need tools → the planner.
      console.log(`[conductor] -> handleSmart (${decision.tier}, effort=${decision.effort ?? "low"})`)
      await this.handleSmart(opts, ctx, emit, decision.effort)
    }
  }

  /** FAST-FRONT: one fast completion that either ANSWERS (chit-chat, acks, context-answerable)
   *  or ROUTES by emitting a directive on its first line —
   *    [[task]]  → the smart planner (tools), this turn
   *    [[think]] → the deep/thinking model, synchronous, time-capped (→ background on timeout)
   *  An optional short say-line after the directive is spoken immediately (latency mask).
   *  The decision is biased toward routing: the front has NO tools, so it cannot act — at worst
   *  a mis-route costs maskable latency, never a confidently-wrong "I did it". */
  private async frontFlow(opts: ConductorOpts, emit: AgentEventHandler): Promise<void> {
    const { utterance, signal, conversationId } = opts

    // GUIDE SESSION SKIP: with a lesson live (or a synthetic auto-continue turn),
    // the front is the wrong brain — it has no tools, and the live session showed it
    // ANSWERING from memory ("I'm highlighting Light again") instead of guiding.
    // Every lesson turn goes straight to the planner with the lesson context.
    // (A mere standalone-highlight hint does NOT skip the front — chit-chat next to
    // a lingering highlight still deserves the fast path.)
    if (opts.synthetic || opts.lessonContext?.includes("## Active walkthrough")) {
      emit({ kind: "agent_intent", tier: "smart", reason: opts.synthetic ? "lesson: auto-continue" : "lesson: active walkthrough" })
      // Synthetic turns stay silent up front — the next step IS the response, and an
      // "On it." after every click would turn the lesson into a call-center script.
      if (!opts.synthetic) await this.speakInterim(nextTaskAck(), signal)
      const smartCtx = await this.deps.contextBuilder.build({ utterance, tier: "smart", conversationId })
      if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }
      // LOW effort — lessons need SPEED between steps, and gemini-2.5-flash matches elements
      // accurately without a big thinking budget (MEDIUM cost ~36s/step for no gain).
      await this.handleSmart(opts, smartCtx, emit, "low")
      return
    }

    const ctx = await this.deps.contextBuilder.build({ utterance, tier: "fast", conversationId })
    if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }

    // Recent turns as real messages so follow-ups ("yes", "the second one") route correctly.
    const recent: Array<{ role: string; content: string }> = []
    if (this.deps.conversationStore && conversationId) {
      try {
        const turns = await this.deps.conversationStore.recentTurns(conversationId, 4)
        for (const t of turns) recent.push({ role: t.role === "agent" ? "assistant" : "user", content: t.text })
      } catch { /* best-effort */ }
    }

    const resp = await this.deps.fastLlm.complete({
      messages: [
        { role: "system", content: ctx.system + FRONT_ADDENDUM },
        ...recent,
        { role: "user", content: utterance },
      ],
      max_tokens: fastMax(200),
    })
    if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }

    let { route, say } = parseFrontDirective(resp.text ?? "")
    // DETERMINISTIC OVERRIDE: an EXPLICIT request for careful thought always gets the
    // think path — the front honors this only stochastically (it answered "think it
    // through: standing desk?" directly). The user's explicit ask outranks the router.
    if (route === "answer" && EXPLICIT_THINK_RE.test(utterance)) {
      route = "think"
      say = undefined
    }
    // DETERMINISTIC SCREEN/DO ROUTING: a do-ask ("switch my Mac to…"), teach-ask, or
    // point-ask can NEVER be answered by the tool-less front — whatever it says is a
    // fabrication or a refusal. Regex-on-the-UTTERANCE beats regex-on-the-claim:
    // the claim wording mutated every round ("I'm highlighting…", "Switched your
    // Mac…", "Got it — switching it back…") and each variant slipped a claim
    // pattern. The ask itself is stable. Live 2026-06-11.
    if (route === "answer" && (DO_ASK_RE.test(utterance) || TEACH_ASK_RE.test(utterance) || GUIDE_RE.test(utterance))) {
      console.log(`[conductor] screen/do ask answered by the front — forcing [[task]]`)
      route = "task"
      say = undefined
    }
    // ANTI-FABRICATION GUARD (defense in depth for OTHER phrasings): the front has
    // NO tools, so any answer CLAIMING an on-screen action ("I'm highlighting Light
    // again — make sure you see it") is a fabrication by construction. Live session
    // 2026-06-10: five such gaslighting replies in a row while nothing happened on
    // screen. Discard the answer and force the planner, which can actually point.
    if (route === "answer" && FABRICATED_ACTION_RE.test(resp.text ?? "")) {
      console.log(`[conductor] front fabricated an on-screen action — forcing [[task]]`)
      route = "task"
      say = undefined
    }
    console.log(`[conductor] front route=${route}${say ? ` say="${say.slice(0, 40)}"` : ""}`)

    if (route === "task") {
      emit({ kind: "agent_intent", tier: "smart", reason: "front: needs tools/actions" })
      // ALWAYS speak something before the planner starts — a turn with no tool calls (e.g. a
      // clarifying question) otherwise has dead air for its whole generation, and users re-ask
      // into the silence, superseding the turn (the 00:33/00:34 silent-turn bug, 2026-06-10).
      await this.speakInterim(ackOnly(say) ?? nextTaskAck(), signal)
      const smartCtx = await this.deps.contextBuilder.build({ utterance, tier: "smart", conversationId })
      if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }
      // LOW effort — fast. Accuracy comes from the capable brain MODEL (gemini-2.5-flash),
      // NOT from a big thinking budget: at MEDIUM, gemini spent ~36s/step THINKING about a
      // trivial "pick the row labeled Sound" — all latency, no benefit. Element-matching +
      // light step-sequencing don't need deep reasoning; the brain still escalates on failure.
      await this.handleSmart(opts, smartCtx, emit, "low")
      return
    }

    if (route === "think") {
      emit({ kind: "agent_intent", tier: "deep", reason: "front: hard reasoning" })
      const smartCtx = await this.deps.contextBuilder.build({ utterance, tier: "smart", conversationId })
      if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }
      if (!this.deps.thinkLlm) {
        // No dedicated thinking model wired → the planner is the next-best reasoner.
        // The fast-front judged this HARD reasoning, so the brain runs at HIGH effort.
        await this.speakInterim(ackOnly(say), signal)
        await this.handleSmart(opts, smartCtx, emit, "high")
        return
      }
      // smartCtx carries the TOOLS (spawn_background_task for the timeout conversion /
      // planner fallback); the SLIM fast system prompt is what the think model reads —
      // think is tool-less, and a big prefill multiplies a reasoning model's silent
      // thinking time (live: 12s+ of no first token on the full smart prompt vs ~3s slim).
      await this.handleThink(opts, smartCtx, emit, say, ctx.system)
      return
    }

    // answer_now — the front's own reply (tool-less by construction, so it can't claim actions).
    emit({ kind: "agent_intent", tier: "fast", reason: "front: answered directly" })
    const text = sanitizeReply(stripFrontDirectives(resp.text ?? "")) || "Sorry, I didn't catch that — could you say it again?"
    emit({ kind: "agent_done", text })
    if (this.deps.speakBackend && !signal?.aborted) {
      try { await this.deps.speakBackend.speak(text) } catch (err) { console.log(`[conductor] front speak error: ${(err as Error).message}`) }
    }
    await this.persistPlainTurn(conversationId, utterance, text)
  }

  /** [[think]]: answer with the deep/thinking model. STREAMING (default when wired):
   *  sentence-by-sentence to the speaker — the cap is a FIRST-TOKEN deadline, so once
   *  the answer starts it runs to completion masked by its own audio. BLOCKING
   *  (fallback): whole answer under a hard time cap. Either way, no answer in time →
   *  convert to a background task ("I'll get back to you") rather than leave dead air. */
  private async handleThink(
    opts: ConductorOpts,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
    say: string | undefined,
    slimSystem?: string,
  ): Promise<void> {
    const { utterance, signal, conversationId } = opts
    emit({ kind: "agent_planning", tier: "deep" })

    const capMs = Number(process.env.KAIROS_THINK_TIMEOUT_MS) || 12000

    if (this.deps.thinkStream && this.deps.streamSink) {
      // Streaming gets its OWN first-token deadline: once audio starts, answer length is
      // free, so waiting longer for the first token is cheap (fillers cover it) and saves
      // far more value than it costs — a converted-to-background think loses the live answer.
      // 30s default: minimax-m3's first content token is HIGHLY variable (measured 3s and
      // 24s on the same slim prompt) — 20s converted too many thinks that were almost ready.
      const firstTokenMs = Number(process.env.KAIROS_THINK_FIRST_TOKEN_MS) || Math.max(capMs, 30000)
      const outcome = await this.streamThink(opts, { system: slimSystem ?? ctx.system, tools: ctx.tools }, emit, say, firstTokenMs)
      if (outcome !== "no_answer") return
      if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }
      return this.convertThinkToBackground(opts, ctx, emit)
    }

    // ── Blocking fallback (no streaming completer wired) ──
    await this.speakInterim(ackOnly(say) ?? "Good question — give me a second to think.", signal)
    const thinkPromise = this.deps.thinkLlm!.complete({
      messages: [
        { role: "system", content: ctx.system + THINK_MODE_ADDENDUM },
        { role: "user", content: utterance },
      ],
      max_tokens: Number(process.env.KAIROS_THINK_MAX_TOKENS) || 1600,
    })

    // Mid-wait filler so a longer think never feels like dead air (only when the cap allows it).
    const fillerTimer = capMs >= 9000
      ? setTimeout(() => {
          if (!signal?.aborted && this.deps.speakBackend) {
            void this.deps.speakBackend.speak("Still thinking — one more moment.").catch(() => { /* */ })
          }
        }, 5000)
      : null

    let answer: string | null = null
    try {
      const r = await Promise.race([
        thinkPromise,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("think timeout")), capMs)),
      ])
      answer = sanitizeReply(r.text) || null
    } catch { answer = null }
    finally { if (fillerTimer) clearTimeout(fillerTimer) }

    if (signal?.aborted) { emit({ kind: "agent_interrupted" }); return }

    if (answer) {
      emit({ kind: "agent_done", text: answer })
      if (this.deps.speakBackend && !signal?.aborted) {
        try { await this.deps.speakBackend.speak(answer) } catch { /* */ }
      }
      await this.persistPlainTurn(conversationId, utterance, answer)
      return
    }

    return this.convertThinkToBackground(opts, ctx, emit)
  }

  /** STREAMING think: fire the deep request first (the ack line then masks model
   *  startup), pipe content deltas through the SpokenStreamFilter into the shared
   *  streaming speaker, and persist/emit the full answer at the end. Reasoning models
   *  think silently (reasoning tokens are excluded upstream), so the first CONTENT
   *  delta is the "answer started" signal the deadline gates on. Once speech begins
   *  the answer runs to completion under a generous hard wall (KAIROS_THINK_HARD_CAP_MS). */
  private async streamThink(
    opts: ConductorOpts,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
    say: string | undefined,
    firstTokenMs: number,
  ): Promise<"spoken" | "interrupted" | "no_answer"> {
    const { utterance, signal, conversationId } = opts
    const sink = this.deps.streamSink!
    const hardCapMs = Number(process.env.KAIROS_THINK_HARD_CAP_MS) || 60000

    // Local controller: a first-token timeout cancels the PROVIDER stream without
    // aborting the whole turn (the background conversion still needs to run).
    const local = new AbortController()
    const onAbort = () => { try { local.abort() } catch { /* */ } }
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.("abort", onAbort, { once: true })

    const filter = new SpokenStreamFilter()
    let raw = ""
    let began = false

    // Lazy generators only fire the fetch on the first next() — prefetch it NOW so the
    // model starts thinking while the ack line is still being spoken.
    const iter = this.deps.thinkStream!({
      messages: [
        { role: "system", content: ctx.system + THINK_MODE_ADDENDUM },
        { role: "user", content: utterance },
      ],
      max_tokens: Number(process.env.KAIROS_THINK_MAX_TOKENS) || 1600,
      signal: local.signal,
    })[Symbol.asyncIterator]()
    let pending = iter.next()

    const firstTokenTimer = setTimeout(() => { if (!began) local.abort() }, firstTokenMs)
    const hardTimer = setTimeout(() => local.abort(), hardCapMs)
    // Mid-wait fillers ONLY before speech begins — once the answer streams, the audio
    // itself is the liveness signal. Two beats so a long think stays conversational.
    const fillerTimers: Array<ReturnType<typeof setTimeout>> = []
    if (firstTokenMs >= 9000) {
      for (const [delay, line] of [
        [5000, "Still thinking — one more moment."],
        [13000, "Almost there."],
        [22000, "This one's worth thinking through properly — bear with me."],
      ] as const) {
        if (delay < firstTokenMs - 1000) {
          fillerTimers.push(setTimeout(() => {
            if (!began && !signal?.aborted && this.deps.speakBackend) {
              void this.deps.speakBackend.speak(line).catch(() => { /* */ })
            }
          }, delay))
        }
      }
    }

    await this.speakInterim(ackOnly(say) ?? "Good question — give me a second to think.", signal)

    try {
      while (true) {
        const r = await pending
        if (r.done) break
        pending = iter.next()
        if (signal?.aborted) break
        const e = r.value
        if (e.kind === "delta" && e.text) {
          raw += e.text
          const safe = filter.push(e.text)
          if (safe) {
            if (!began) { began = true; sink.begin() }
            sink.feed(safe)
            emit({ kind: "agent_delta", text: safe })
          }
        } else if (e.kind === "error") {
          console.log(`[conductor] think stream error: ${e.message ?? "unknown"}`)
          break
        }
      }
    } catch { /* aborted/transport — resolved via `began` below */ }
    finally {
      clearTimeout(firstTokenTimer)
      clearTimeout(hardTimer)
      for (const t of fillerTimers) clearTimeout(t)
      try { signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
      try { iter.return?.() } catch { /* */ }
    }

    if (signal?.aborted) {
      try { sink.cancel() } catch { /* */ }
      emit({ kind: "agent_interrupted" })
      return "interrupted"
    }

    if (!began) return "no_answer"   // never started answering — hand off to background

    try { const tail = filter.flush(); if (tail) sink.feed(tail) } catch { /* */ }
    try { await sink.end() } catch { /* */ }

    const answer = sanitizeReply(raw) || "Sorry — I lost my train of thought there. Ask me again?"
    emit({ kind: "agent_done", text: answer })
    await this.persistPlainTurn(conversationId, utterance, answer)
    return "spoken"
  }

  /** Think didn't produce an answer in time → hand it to the background lane and say so.
   *  The goal is the user's OWN question verbatim — it gets echoed in the spoken report
   *  ("Done with …"), so it must sound human, never like an internal prompt. */
  private async convertThinkToBackground(
    opts: ConductorOpts,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
  ): Promise<void> {
    const { utterance, signal } = opts
    const spawn = ctx.tools.find((t) => t.name === "spawn_background_task")
    if (spawn) {
      try { await spawn.execute({ goal: utterance }) } catch { /* */ }
      const line = "This is taking me a moment — I'll work on it and get back to you."
      emit({ kind: "agent_done", text: line })
      if (this.deps.speakBackend && !signal?.aborted) { try { await this.deps.speakBackend.speak(line) } catch { /* */ } }
    } else {
      // No background lane available → planner is the last resort. This was a HARD
      // reasoning turn that already exceeded the think budget, so retry at HIGH effort.
      await this.handleSmart(opts, ctx, emit, "high")
    }
  }

  /** Persist a tool-less turn so the replay transcript stays continuous, and kick the
   *  layered-history compaction (digests + rolling summary) OFF the hot path — fast
   *  chit-chat turns age out of the raw window too, and without this a chatty
   *  conversation never built its L1/L2 layers (only smart turns compacted). */
  private async persistPlainTurn(conversationId: string | undefined, utterance: string, answer: string): Promise<void> {
    if (!this.deps.conversationMessages || !conversationId) return
    try {
      await this.deps.conversationMessages.appendTurn(conversationId, `turn_${Date.now().toString(36)}`, [
        { role: "user", content: utterance },
        { role: "assistant", content: answer },
      ])
    } catch { /* persistence is best-effort */ }
    if (process.env.KAIROS_CONV_SUMMARY !== "0" && this.deps.conversationMessages.updateRollingSummary) {
      void this.deps.conversationMessages
        .updateRollingSummary(conversationId, (text) => this.summarizeConversation(text))
        .catch(() => { /* summary is best-effort */ })
    }
  }

  /** Speak a short, fact-free interim line (the latency mask) — sanitized, never blocking errors. */
  private async speakInterim(say: string | undefined, signal?: AbortSignal): Promise<void> {
    if (!say || !this.deps.speakBackend || signal?.aborted) return
    const line = sanitizeSpoken(say).slice(0, 120)
    if (!line) return
    try { await this.deps.speakBackend.speak(line) } catch { /* interim must never break the turn */ }
  }

  private async handleFast(
    utterance: string,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
    signal?: AbortSignal,
    conversationId?: string,
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
    // Persist the (tool-less) turn so the replay transcript stays continuous — a
    // "thank you / got it" between two action turns shouldn't leave a hole.
    await this.persistPlainTurn(conversationId, utterance, text)
  }

  private async handleSmart(
    opts: ConductorOpts,
    ctx: { system: string; tools: ToolDef[] },
    emit: AgentEventHandler,
    // DYNAMIC per-task reasoning effort, decided by the router (classifier/fast-front)
    // and handed to the brain. Conservative: omitted/low for routine turns, high only
    // when the task clearly needs deep reasoning. The brain auto-escalates on failure.
    effort?: "low" | "medium" | "high",
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
          // SILENT_TOOLS: instant local tools where an ack is pure noise (the guide
          // suite especially — "Opening guide now" on every point drove users mad),
          // and tools whose silence IS the experience (wait_for_screen: the user is
          // busy clicking; chirping fillers at them would be backseat driving).
          ackPhrase: (name, args) => (SILENT_ACK_TOOLS.has(name) ? "" : pickAck(name, args)),
          fillerPhrase: (lastTool) =>
            lastTool && SILENT_WAIT_TOOLS.has(lastTool.name)
              ? ""
              : pickFiller(lastTool ? describeAction(lastTool.name, lastTool.args).noun : undefined),
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

    // Durable replay: seed the planner with prior real messages (incl. tool results)
    // so it can chain off what it already did ("reply to that same email" → the gmail
    // threadId from the earlier send). Off the hot path's critical section (a cheap
    // indexed read); disabled with KAIROS_CONV_REPLAY=0.
    let history: LoopMsg[] = []
    if (process.env.KAIROS_CONV_REPLAY !== "0" && this.deps.conversationMessages && opts.conversationId) {
      try { history = await this.deps.conversationMessages.loadForReplay(opts.conversationId) } catch { /* replay is best-effort */ }
    }

    const runFn = this.deps.runPlanner ?? defaultPlannerRunner
    // BRAIN-ROUTER LANE: a guidance/teaching turn (an active lesson, or a teach/locate
    // utterance) is the latency-critical, advanced-guide-tools path → keep it in-house.
    // Everything else (general agentic tasks) → opencode-first (with in-house fallback).
    const isGuidance = !!opts.lessonContext || TEACH_ASK_RE.test(opts.utterance) || GUIDE_RE.test(opts.utterance)
    const lane: "guidance" | "general" = isGuidance ? "guidance" : "general"
    // Lesson context rides on the INSTRUCTIONS, not the utterance — it's daemon
    // state ("you last highlighted Appearance; it's still on screen"), and the
    // utterance must stay the user's words for the verifier + transcript.
    const result = await runFn(opts.utterance, {
      tools: ctx.tools,
      instructions: opts.lessonContext ? `${ctx.system}\n\n${opts.lessonContext}` : ctx.system,
      signal: opts.signal,
      onEvent,
      history,
      effort,
      lane,
    })

    try { opts.signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
    await controller?.finish()

    // A superseded/aborted turn must end QUIETLY — emitting agent_done with the
    // "wasn't able to finish" fallback put phantom failures in the transcript (the
    // NEW turn is already answering; this one just stands down).
    if (opts.signal?.aborted) { emit({ kind: "agent_interrupted" }); return }

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

    // Persist this turn's real messages (user + tool exchange incl. results + final
    // answer) so the NEXT turn can replay them. Off the hot path — already spoke.
    if (this.deps.conversationMessages && opts.conversationId) {
      try {
        const turnId = opts.runId ?? `turn_${Date.now().toString(36)}`
        await this.deps.conversationMessages.appendTurn(opts.conversationId, turnId, buildTurnMessages(opts.utterance, result.toolCalls, reply))
      } catch { /* persistence is best-effort; must never break a turn */ }

      // Roll older turns into the summary OFF the hot path (fire-and-forget — we've
      // already spoken). Cheap fast-model digest; never blocks or breaks the turn.
      if (process.env.KAIROS_CONV_SUMMARY !== "0" && this.deps.conversationMessages.updateRollingSummary) {
        const cid = opts.conversationId
        void this.deps.conversationMessages
          .updateRollingSummary(cid, (text) => this.summarizeConversation(text))
          .catch(() => { /* summary is best-effort */ })
      }
    }

    // Log to the durable ACTIVITY timeline — only turns that DID something (used a
    // real tool); pure chitchat is skipped. Powers "what did you do yesterday".
    if (this.deps.activity && opts.conversationId) {
      try {
        const real = result.toolCalls.filter((c) => c.name !== "update_plan" && c.name !== "search_tools")
        if (real.length > 0) {
          const isWrite = (c: { name: string; args: any }) => { try { return isDestructiveCall({ name: c.name, args: c.args }) } catch { return false } }
          const hadWrite = real.some(isWrite)
          const primary = real.find(isWrite) ?? real[real.length - 1]!
          this.deps.activity.record({
            at: Date.now(),
            kind: hadWrite ? "action" : "read",
            lane: "foreground",
            conversationId: opts.conversationId,
            tool: effectiveToolName(primary),
            title: activityTitle(primary),
            detail: opts.utterance,
            status: real.some((c) => c.error) ? "failed" : "done",
            importance: hadWrite ? 0.8 : 0.4,
            ref: extractRefs(real),
          })
        }
      } catch { /* activity logging is best-effort; never breaks a turn */ }
    }
  }

  /** Cheap-model digest of older conversation turns for the rolling summary. */
  private async summarizeConversation(text: string): Promise<string> {
    const r = await this.deps.fastLlm.complete({
      messages: [
        { role: "system", content: CONVERSATION_SUMMARY_PROMPT },
        { role: "user", content: text },
      ],
      max_tokens: fastMax(300),
    })
    return sanitizeReply(r.text)
  }
}

const THINK_MODE_ADDENDUM =
  "\n\n## Think mode\nReason carefully, then answer the user directly and completely. " +
  "You have NO tools — never claim to have looked anything up or done anything. " +
  "Plain spoken prose only — conversational, focused, no headings or lists."

const CONVERSATION_SUMMARY_PROMPT =
  "You are maintaining a running memory of a voice conversation so it can be remembered after the recent turns scroll off. " +
  "Given the existing summary (if any) plus the newer earlier turns, write an updated, compact summary. " +
  "PRESERVE: what the user asked for and cares about, decisions made, names/people, and any concrete identifiers or values that a later turn might need (email recipients, thread ids, issue ids, file paths, amounts, dates). " +
  "Drop pleasantries and filler. Keep it tight — a few sentences. Write plain text, no markdown."

/** Reconstruct a turn's durable real-message trace from the planner result: the user
 *  utterance, the tool exchange (one assistant tool_calls message + a tool result per
 *  call, carrying ids/threadIds), and the final spoken answer. update_plan is a
 *  loop-scoped scratchpad → excluded. Tool results are clamped (ids survive; full
 *  bodies don't bloat the store/replay). Pairs stay intact (orphan-safe). */
function buildTurnMessages(
  input: string,
  toolCalls: Array<{ id: string; name: string; args: any; result?: any; error?: string }>,
  reply: string,
): LoopMsg[] {
  const msgs: LoopMsg[] = [{ role: "user", content: input }]
  const real = toolCalls.filter((c) => c.name !== "update_plan")
  if (real.length > 0) {
    msgs.push({
      role: "assistant",
      tool_calls: real.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: safeStringify(c.args) } })),
    })
    for (const c of real) {
      const content = c.error
        ? `Error: ${String(c.error).slice(0, 600)}`
        : clampResult(c.result)
      msgs.push({ role: "tool", tool_call_id: c.id, content })
    }
  }
  if (reply && reply.trim()) msgs.push({ role: "assistant", content: reply })
  return msgs
}

/** The REAL action behind a call: execute_tool wraps the Composio action under
 *  `tool_name` (matches verifier.effectiveName). */
function effectiveToolName(c: { name: string; args: any }): string {
  if (c.name === "execute_tool" && c.args && typeof c.args === "object") {
    return c.args.tool_name || c.args.tool || c.args.toolName || c.args.action || c.name
  }
  return c.name
}

/** A short, human title for the activity log. Humanizing the SCREAMING_SNAKE tool name
 *  is reliable + informative ("GMAIL_SEND_EMAIL" → "Gmail send email"); the user's
 *  request is stored separately as the detail. */
function activityTitle(c: { name: string; args: any }): string {
  const name = effectiveToolName(c)
  const human = String(name).replace(/_/g, " ").toLowerCase().trim()
  return human ? human.charAt(0).toUpperCase() + human.slice(1) : name
}

/** Pull id-like handles from the tool results (for linking in the HUD — not bodies). */
function extractRefs(calls: Array<{ result?: any }>): Record<string, unknown> | undefined {
  const ref: Record<string, unknown> = {}
  for (const c of calls) {
    const r = c.result?.data ?? c.result
    if (r && typeof r === "object") for (const k of ["id", "threadId", "messageId", "issueId", "url"]) if (r[k] != null && ref[k] == null) ref[k] = r[k]
  }
  return Object.keys(ref).length ? ref : undefined
}

const REPLAY_RESULT_MAX = Number(process.env.KAIROS_REPLAY_RESULT_MAX) || 1500
function clampResult(result: any): string {
  if (result == null) return "(no result)"
  const s = typeof result === "string" ? result : safeStringify(result)
  return s.length > REPLAY_RESULT_MAX ? s.slice(0, REPLAY_RESULT_MAX) + "…(truncated)" : s
}
function safeStringify(v: any): string { try { return JSON.stringify(v ?? {}) } catch { return "{}" } }

// The ONE guard for spoken text (strip <think>/reasoning, never voice tool-markup) —
// shared with the background report + the live delta stream so all three can't drift.
const sanitizeReply = sanitizeSpoken

// ── Fast-front routing (the collapse: the fast model IS the router) ──────────────────
// Appended to the fast system prompt. The grammar is tiny on purpose — a weak model
// reliably handles "first line = one of two tokens", where free-form JSON would drift.
const FRONT_ADDENDUM = `

## Routing (you are the front of the assistant)
You have NO tools and cannot look anything up, check anything, or take any action yourself.
- If the message is small talk, a quick acknowledgment, an opinion, or fully answerable from the conversation above — just reply normally (1–2 short spoken sentences).
- Otherwise route it by starting your reply with a directive as the FIRST thing:
  [[task]] — anything involving the user's apps, data, or the outside world (email, calendar, messages, files, search, screen, "do X", "check Y"), or any multi-step work. This INCLUDES every request to show/point/guide/teach anything ON SCREEN, and every request to DO something on their Mac (open/click/change a setting/switch a mode/type) — you cannot see, point at, or touch the screen yourself.
  [[think]] — a genuinely hard reasoning question answerable by pure thought alone (analysis, tradeoffs, math, judgment) with no lookups needed. If the user EXPLICITLY asks for careful thought ("think it through", "think hard", "reason about"), always route [[think]] — honor the ask even if it seems easy.
- HARD RULE: any question about the user's OWN current state — what's connected, what's on the calendar, unread email, files, tasks, recent activity, anything that changes over time — is NEVER answerable from your memory. You do not know it. Route [[task]] even if you believe you know the answer.
- Recalled memory lines ("Relevant memory") are BACKGROUND about the past — never resume or continue an activity from them as if it were happening now. Only the conversation directly above is live.
- After the directive you may add ONE short spoken acknowledgment (max ~8 words). It must contain NO facts, NO opinions, and NO part of an answer — only an acknowledgment like "on it — checking now." or "good question — one sec."
- NEVER claim to have done, sent, checked, or found anything. If unsure whether you can answer correctly right now, route to [[task]].

Examples (follow these exactly):
User: "hey, how's it going?" → Good, busy. What's up?
User: "thanks, that's perfect" → Anytime.
User: "what's on my calendar today?" → [[task]] checking your calendar now.
User: "any new emails from Sam?" → [[task]] taking a look.
User: "send Sam a quick thanks email" → [[task]] on it.
User: "what apps are connected?" → [[task]] one sec.
User: "remind me what we decided about the demo" → [[task]] let me pull that up.
User: "yes, go ahead" (after you offered to do something) → [[task]]
User: "research flights to Tokyo in the background" → [[task]] starting that now.
User: "where's the export button in this app?" → [[task]] let me show you.
User: "walk me through setting up a signature in Mail" → [[task]] sure — I'll guide you.
User: "okay, it's open now" (after a step you asked for — an app opened, a page loaded) → [[task]] great — one sec.
User: "done, what's next?" (mid-walkthrough) → [[task]] next step coming up.
User: "teach me how to crop a photo in Photoshop" → [[task]] sure — I'll walk you through it.
User: "think it through: should I lease or buy a car?" → [[think]] good question — give me a moment.
User: "what's 18% of 2,450?" → [[think]]
User: "which of these two job offers is better, all things considered?" → [[think]] let me think that through.
User: "do you like jazz?" → Love it — there's nothing like late-period Coltrane. You?`

// Instant LOCAL tools — never speak an ack for these (sub-100ms, and the model speaks
// its own sync line right after for the guide suite). wait_for_screen additionally
// suppresses "still on it…" fillers: its silence means the user is mid-step.
const SILENT_ACK_TOOLS = new Set([
  "guide_user", "read_screen", "wait_for_screen", "open_app", "end_lesson", "recall_memory", "update_plan",
  // Act mode narrates itself ("Opening Appearance — now switching to Dark");
  // a canned "on it" before every click would double-speak each step.
  "click_element", "type_text",
])
const SILENT_WAIT_TOOLS = new Set(["wait_for_screen"])

// Explicit ask for deliberate reasoning — deterministically routed to [[think]].
const EXPLICIT_THINK_RE = /\b(think (it|this|that) through|think (hard|carefully|deeply)|reason (about|through)|deep think)\b/i

// A tool-less front answer CLAIMING an on-screen act (highlight/point/show/open/
// guide/switch/click/change…) is fabrication by construction — the front cannot
// touch the screen. First-person-future forms ("I'll show you") count too: a
// promise the front can't keep is the same lie one tense earlier. Bare past-tense
// act claims ("Switched your Mac back to dark mode." — live 2026-06-11, a 0.9s
// front answer with zero tools) count without a pronoun.
const FABRICATED_ACTION_RE =
  /\b(i('?m| am|'?ve| have|'?ll| will| can| just)\s+(just\s+|now\s+|go ahead and\s+|re-?)*(highlight|point|show (you|it|the)|guid|open|click|switch|chang|set|turn|enabl|disabl|typ)\w*|highlighted|highlighting|^(done[.!,]? )?(switched|changed|opened|clicked|enabled|disabled|turned|set) )/i

const FRONT_DIRECTIVE_RE = /^\s*\[\[\s*(task|think)\s*\]\]\s*/i

/** Parse the front model's reply: a leading [[task]]/[[think]] routes; anything else answers. */
function parseFrontDirective(text: string): { route: "answer" | "task" | "think"; say?: string } {
  const m = FRONT_DIRECTIVE_RE.exec(text ?? "")
  if (!m) return { route: "answer" }
  const say = (text.slice(m[0].length).split("\n")[0] ?? "").trim() || undefined
  return { route: m[1]!.toLowerCase() as "task" | "think", say }
}

/** Scrub any stray/misplaced directive markup so it is never spoken. */
function stripFrontDirectives(text: string): string {
  return text.replace(/\[\[[^\]]*\]\]/g, " ").replace(/\s{2,}/g, " ").trim()
}

// Canned task acks for when the front gave no say-line — rotated so consecutive turns never
// open identically (sounding scripted is worse than sounding brief).
const TASK_ACKS = ["On it.", "Sure — one sec.", "Okay, let me handle that.", "Alright, doing it now.", "Let me take care of that."]
let lastTaskAck = -1
function nextTaskAck(): string {
  let i = Math.floor(Math.random() * TASK_ACKS.length)
  if (i === lastTaskAck) i = (i + 1) % TASK_ACKS.length
  lastTaskAck = i
  return TASK_ACKS[i]!
}

/** Defensive guard on the say-line: it must be a SHORT fact-free ack. A weak front model
 *  sometimes starts ANSWERING after the directive ("Renting could save on upfront costs and…")
 *  — speaking that would leak a half-answer before the real one. Anything that doesn't look
 *  like a brief ack is dropped (caller substitutes a canned line or stays silent). */
function ackOnly(say: string | undefined): string | undefined {
  const s = (say ?? "").trim()
  if (!s) return undefined
  if (s.length > 60) return undefined                      // too long to be an ack — it's substance
  if (/\b(because|costs?|saves?|better|worse|should|means|therefore)\b/i.test(s)) return undefined  // answer-y
  return s
}

/** Default planner runner — drives the KAIROS Agent Loop (our owned, Codex-grade
 *  loop) on the streaming OpenRouter adapter with the SMART-tier model. Replaces
 *  the old @openai/agents run() so we get tool-error self-correction, max-turns,
 *  empty-output guard, and (Phase 3) live narration. Same return shape as before
 *  so handleSmart and the conductor tests are unaffected. */
export async function defaultPlannerRunner(
  input: string,
  opts: { tools: ToolDef[]; instructions: string; signal?: AbortSignal; onEvent?: (e: LoopEvent) => void; history?: LoopMsg[]; effort?: "low" | "medium" | "high" },
): Promise<{
  finalOutput: string
  streamedText?: string
  corrected?: boolean
  toolCalls: Array<{ id: string; name: string; args: any; result?: any; error?: string }>
}> {
  const { OpenRouterAdapter } = await import("../wrapApi/adapters/openRouterAdapter")
  const { runAgentLoop } = await import("./loop/agentLoop")
  const { buildProseDistiller } = await import("./loop/toolExecutor")
  const { buildCompactor, COMPACT_PROMPT } = await import("./loop/compactor")
  const { buildUpdatePlanTool } = await import("./loop/updatePlanTool")
  const { buildDestructiveVerifier, TEACHING_RE } = await import("./loop/verifier")
  const { TIER_MODELS, verifyModel } = await import("./types")

  // Generous token budget: a reasoning SMART model (kimi-k2.5/minimax) spends tokens
  // on its (excluded) chain-of-thought, so a 512 default left no room for the actual
  // answer → empty reply. The spoken answer stays short (the prompt enforces brevity);
  // this headroom is for the hidden reasoning. Tune with KAIROS_SMART_MAX_TOKENS.
  // SMART generates the SPOKEN reply, so it must be talk-and-tools, NOT thinking. If
  // it's a thinking/hybrid model (gemini-2.5-flash), disableThinking forces thinking
  // OFF (reasoning.max_tokens:0) so it can't burn the budget and return empty. Off via
  // KAIROS_SMART_DISABLE_THINKING=0. Harmless on a pure non-thinking smart model.
  // TEACHING TURNS THINK. Guided walkthroughs are a multi-step protocol (look →
  // point → speak → wait → repeat) that flash-without-thinking reliably fumbles —
  // HeyClicky's lesson: guidance quality is model-bound. Step gaps are user-paced
  // (they're clicking), so thinking latency is free here. Reasoning stays EXCLUDED
  // from content (never spoken). KAIROS_GUIDE_THINKING=0 opts out.
  // A lesson continuation turn ("Done. What's next?") doesn't match TEACHING_RE,
  // but its instructions carry the lesson block — it IS a teaching turn (thinking
  // on, walkthrough-sized turn budget).
  const teachingTurn = TEACHING_RE.test(input) || opts.instructions.includes("## Active walkthrough")
  // DYNAMIC per-task effort (the in-house brain's equivalent of the opencode proxy
  // alias): medium/high → THINK at that budget (overrides the default thinking-off,
  // reasoning still EXCLUDED from the spoken content); low/undefined → keep the fast
  // thinking-off path. So the conductor's per-task decision shapes this loop too.
  const wantThink = opts.effort === "high" || opts.effort === "medium"
  const disableThinking = wantThink
    ? false
    : (teachingTurn ? process.env.KAIROS_GUIDE_THINKING === "0" : process.env.KAIROS_SMART_DISABLE_THINKING !== "0")
  const smart = new OpenRouterAdapter({
    defaultModel: TIER_MODELS.smart(),
    defaultMaxTokens: Number(process.env.KAIROS_SMART_MAX_TOKENS) || 4096,
    disableThinking,
    reasoningEffort: wantThink ? opts.effort : undefined,
    usageLabel: "planner_smart",
  })
  // Cheap model for compaction summaries.
  const fast = new OpenRouterAdapter({ defaultModel: process.env.KAIROS_MEMORY_MODEL ?? TIER_MODELS.fast(), usageLabel: "planner_fast" })
  // SEPARATE model for the grounding verify gate (the anti-hallucination judge). It
  // tracks the smart model unless KAIROS_VERIFY_MODEL pins it (types.ts), so a
  // gemini-only user no longer fires silent gpt-4o verify calls. Same thinking-off
  // policy (it produces a JSON verdict, not reasoning prose).
  const verify = new OpenRouterAdapter({ defaultModel: verifyModel(), disableThinking: true, usageLabel: "verify" })
  // Observability: log the resolved models for THIS planner turn. Nothing logged
  // per-turn model usage before, which is why the phantom gpt-4o verify calls were
  // invisible. One line per smart/planner turn makes model routing auditable.
  console.log(`[models] planner turn — smart=${TIER_MODELS.smart()} verify=${verifyModel()}`)

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
      // Durable replay of prior turns (real messages incl. tool results) so the model
      // can chain off an id it already obtained. Bounded + tool-pair-safe upstream.
      ...(opts.history ?? []),
      { role: "user", content: input },
    ],
    {
      llm: smart as unknown as import("./loop/types").LoopLlm,
      // Walkthroughs are long by NATURE (point→wait→point per step + retries) — a
      // 5-step lesson legitimately needs ~20 rounds; the default budget cut one off
      // mid-lesson and the forced-final came back empty.
      maxTurns: teachingTurn ? 26 : undefined,
      tools,
      signal: opts.signal,
      onEvent: opts.onEvent,          // live streaming → the conductor speaks as it generates
      compact: (m, t) => compactor.maybeCompact(m, t),
      verify: (o) => verifier.verify({ utterance: input, finalText: o.finalText, toolCalls: o.toolCalls }),
      // Cheap-LLM prose distiller for over-budget unstructured tool results (reuse the fast model).
      distill: buildProseDistiller(async (p, s) =>
        (await fast.complete({ messages: [{ role: "user", content: p }], max_tokens: 300, signal: s }) as any)?.text ?? ""),
    },
  )

  // res.finalText is already verified/corrected by the in-loop gate.
  let finalOutput = res.finalText

  // Empty-output recovery: if the model ran a tool that already produced a complete,
  // user-facing STRING answer and then said nothing, speak that result instead of the
  // generic "I wasn't able to finish that". ALLOWLIST ONLY: most tool results are
  // INSTRUCTIONS TO THE MODEL, not speech — a silent turn once read wait_for_screen's
  // "IMMEDIATELY speak the next step and point (guide_user)…" straight into TTS.
  if (!finalOutput.trim()) {
    const SPEAKABLE_RESULT_TOOLS = new Set(["spawn_background_task", "background_tasks"])
    const lastStr = [...res.toolCalls].reverse().find(
      (c) => SPEAKABLE_RESULT_TOOLS.has(c.name) && typeof c.result === "string" && String(c.result).trim(),
    )
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

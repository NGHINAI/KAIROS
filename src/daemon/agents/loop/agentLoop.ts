// src/daemon/agents/loop/agentLoop.ts
// The KAIROS Agent Loop (KAL) — our owned, Codex-grade agentic loop on the
// streaming OpenRouterAdapter. Per turn: stream the model (emitting text deltas
// live for narration), collect tool calls, execute them with self-correction
// (errors fed back as tool results), append results, and loop until the model
// answers with no tool call. Bounded by maxTurns; never returns silent text.

import type { ToolDef } from "../types"
import { executeToolCall } from "./toolExecutor"
import { isDestructiveCall } from "./verifier"
import { toolsToSchemas, type AgentLoopResult, type LoopEvent, type LoopLlm, type LoopMsg, type ToolCall } from "./types"

export interface AgentLoopDeps {
  llm: LoopLlm
  tools: ToolDef[]
  maxTurns?: number
  maxTokens?: number
  model?: string
  onEvent?: (e: LoopEvent) => void
  signal?: AbortSignal
  emptyFallback?: string
  /** Optional context compaction hook, run after each tool round. */
  compact?: (messages: LoopMsg[], tokensIn: number) => Promise<LoopMsg[]>
  /** Optional cheap-LLM prose distiller for over-budget UNSTRUCTURED tool results (web pages,
   *  long docs). Structured results are always shaped deterministically; this only ever phrases
   *  prose, and the executor validates it can't invent a number/id. See buildProseDistiller. */
  distill?: (text: string) => Promise<string>
  /** Injectable sleep (tests pass a no-op). Default backs off real time. */
  sleep?: (ms: number) => Promise<void>
  /** After this many consecutive ALL-failed tool rounds, inject a re-plan note so
   *  the model steps back instead of repeating a failing call. Default 2. */
  replanAfter?: number
  /** After this many IDENTICAL tool rounds (same calls + args, regardless of
   *  success), inject a "you're repeating yourself" nudge — catches stalls where
   *  the model loops on a half-working approach without ever fully failing. Default 2. */
  stallAfter?: number
  /** Grounded-verify gate. Before accepting the model's final answer on a turn
   *  that used tools, check the claim is supported by the tool ledger. On a flag,
   *  the loop injects the concern and runs ONE more round so the model actually
   *  performs the claimed action (or restates from the results) — "self-correct,
   *  then speak". Omitted = no gate (legacy behavior). */
  verify?: (o: {
    finalText: string
    toolCalls: AgentLoopResult["toolCalls"]
  }) => Promise<{ ok: boolean; concern?: string; correction?: string }>
  /** Max self-correction rounds the verify gate may trigger. Default 1. */
  maxCorrections?: number
}

/** Render a plan as a spoken-safe checklist for re-plan/stall notes. */
function renderPlan(plan: Array<{ step: string; status: string }> | undefined): string {
  if (!plan || plan.length === 0) return ""
  const lines = plan.map((s) => `  - [${s.status === "completed" ? "x" : s.status === "in_progress" ? "~" : " "}] ${s.step}`).join("\n")
  return `\nYour current plan:\n${lines}`
}

const DEFAULT_MAX_TURNS = Number(process.env.KAIROS_MAX_AGENT_TURNS) || 12
const EMPTY_FALLBACK = "Sorry, I didn't catch that — could you say it again?"
const STREAM_ERROR_FALLBACK = "I hit a connection problem just now — could you try that again?"
const MAX_STREAM_RETRIES = 2   // per turn, on transport/provider errors

export async function runAgentLoop(initial: LoopMsg[], deps: AgentLoopDeps): Promise<AgentLoopResult> {
  const maxTurns = deps.maxTurns ?? DEFAULT_MAX_TURNS
  const schemas = toolsToSchemas(deps.tools)
  const emit = deps.onEvent ?? (() => {})
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const msgs: LoopMsg[] = [...initial]
  const toolCalls: AgentLoopResult["toolCalls"] = []
  const replanAfter = deps.replanAfter ?? (Number(process.env.KAIROS_REPLAN_AFTER) || 2)
  const stallAfter = deps.stallAfter ?? (Number(process.env.KAIROS_STALL_AFTER) || 2)
  let consecutiveFailedRounds = 0
  let badSlugNudged = false
  let lastPlan: Array<{ step: string; status: string }> | undefined
  let prevSignature = ""
  let identicalRounds = 1

  for (let turn = 1; turn <= maxTurns; turn++) {
    if (deps.signal?.aborted) return { finalText: "", toolCalls, turns: turn, stopped: "aborted" }

    const lastTurn = turn === maxTurns
    let text = ""
    let tokensIn = 0
    let calls: ToolCall[] = []
    let streamError: Error | null = null

    // Stream the model with retry on transport/provider errors — a transient 429
    // or socket blip must NOT crash the voice turn into dead air.
    for (let attempt = 0; attempt <= MAX_STREAM_RETRIES; attempt++) {
      text = ""
      calls = []
      streamError = null
      try {
        for await (const ev of deps.llm.stream({
          messages: msgs,
          model: deps.model,
          max_tokens: deps.maxTokens,
          tools: schemas,
          // On the final allowed turn, forbid more tool calls so we get a spoken answer.
          tool_choice: lastTurn ? "none" : "auto",
          signal: deps.signal,
        })) {
          if (ev.kind === "delta") { text += ev.text; emit({ kind: "assistant_delta", text: ev.text }) }
          else if (ev.kind === "tool_use") calls.push({ id: ev.id, name: ev.name, argsJson: ev.args_json })
          else if (ev.kind === "done") { tokensIn = ev.tokensIn ?? tokensIn }
          else if (ev.kind === "error") throw new Error(ev.message)
        }
        break // streamed cleanly
      } catch (e) {
        streamError = e as Error
        if (deps.signal?.aborted) break
        if (attempt < MAX_STREAM_RETRIES) await sleep(250 * Math.pow(2, attempt))
      }
    }

    if (deps.signal?.aborted) return { finalText: "", toolCalls, turns: turn, stopped: "aborted" }
    if (streamError) {
      // Retries exhausted — return a graceful, spoken-safe result instead of throwing.
      const finalText = deps.emptyFallback || STREAM_ERROR_FALLBACK
      emit({ kind: "final", text: finalText })
      return { finalText, toolCalls, turns: turn, stopped: "error" }
    }

    // Tool round (not on the final turn — there we force an answer).
    if (calls.length > 0 && !lastTurn) {
      msgs.push({
        role: "assistant",
        // Omit content entirely when empty — providers reject content:"" with tool_calls.
        ...(text ? { content: text } : {}),
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.argsJson } })),
      })
      // Execute the turn's tool calls: concurrency-safe ones (reads) in PARALLEL,
      // the rest serially. Results are fed back in ORIGINAL call order so the
      // tool messages line up deterministically with the assistant's tool_calls.
      const runOne = async (c: ToolCall) => {
        let args: any = {}
        try { args = c.argsJson ? JSON.parse(c.argsJson) : {} } catch { /* executor reports the parse error */ }
        emit({ kind: "tool_call_start", id: c.id, name: c.name, args })
        const res = await executeToolCall(c, deps.tools, { signal: deps.signal, distill: deps.distill })
        if (res.ok) emit({ kind: "tool_call_done", id: c.id, name: c.name, result: res.result })
        else emit({ kind: "tool_call_failed", id: c.id, name: c.name, error: res.content })
        // R4: surface the plan to the UI / check-ins / trajectory the moment it changes.
        if (c.name === "update_plan" && Array.isArray(args?.plan)) {
          lastPlan = args.plan.map((s: any) => ({ step: String(s?.step ?? ""), status: String(s?.status ?? "pending") }))
          emit({ kind: "plan_update", plan: lastPlan })
        }
        return { c, args, res }
      }
      const isSafe = (c: ToolCall) => deps.tools.find((t) => t.name === c.name)?.concurrencySafe === true
      const outcomes = new Map<string, { c: ToolCall; args: any; res: Awaited<ReturnType<typeof executeToolCall>> }>()
      for (const o of await Promise.all(calls.filter(isSafe).map(runOne))) outcomes.set(o.c.id, o)
      for (const c of calls.filter((c) => !isSafe(c))) { const o = await runOne(c); outcomes.set(o.c.id, o) }
      for (const c of calls) {
        const o = outcomes.get(c.id)!
        msgs.push({ role: "tool", tool_call_id: o.res.tool_call_id, content: o.res.content })
        toolCalls.push({ name: c.name, args: o.args, result: o.res.ok ? o.res.result : undefined, error: o.res.ok ? undefined : o.res.content })
      }

      // Reflection: if a whole tool round failed (no success), count it; after
      // `replanAfter` consecutive all-failed rounds, nudge the model to change
      // tack instead of hammering the same broken call. Any success resets it.
      const roundOutcomes = [...outcomes.values()]
      const allFailed = roundOutcomes.length > 0 && roundOutcomes.every((o) => !o.res.ok)
      if (allFailed) {
        consecutiveFailedRounds++
        if (consecutiveFailedRounds >= replanAfter) {
          const errs = roundOutcomes.map((o) => o.res.content).join("; ").slice(0, 300)
          msgs.push({
            role: "system",
            content: `The last ${consecutiveFailedRounds} tool attempts all failed (${errs}). Step back and try a DIFFERENT tool or approach — or tell the user plainly what's blocking. Do not repeat the same failing call.${renderPlan(lastPlan)}`,
          })
          consecutiveFailedRounds = 0
        }
      } else {
        consecutiveFailedRounds = 0
      }

      // R6 stall detection: the model can loop on a half-working approach WITHOUT
      // ever fully failing (so the all-failed counter never trips). If it issues the
      // exact same call(s) round after round, nudge it to change tack. Signature
      // excludes update_plan so re-planning itself doesn't look like a stall.
      const sigCalls = calls.filter((c) => c.name !== "update_plan")
      const signature = sigCalls.map((c) => `${c.name}:${c.argsJson ?? ""}`).sort().join("|")
      if (signature && signature === prevSignature) {
        identicalRounds++
        if (identicalRounds >= stallAfter) {
          msgs.push({
            role: "system",
            content: `You've now made the same tool call(s) ${identicalRounds} times in a row with no new outcome. Repeating the identical call won't change the result — change your approach, try a different tool or arguments, or tell the user what's blocking.${renderPlan(lastPlan)}`,
          })
          identicalRounds = 1
          prevSignature = ""
        }
      } else {
        identicalRounds = 1
        prevSignature = signature
      }
      // Compaction trigger. CRITICAL: OpenRouter doesn't report token usage during
      // streaming, so tokensIn is often 0 — fall back to a char-based estimate
      // (~4 chars/token) so a long multi-tool turn can't grow the context until the
      // model 400s on its window. Use the larger of reported vs estimated.
      const estTokens = Math.ceil(
        msgs.reduce((n, m: any) => n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m).length), 0) / 4,
      )
      const effectiveTokens = Math.max(tokensIn, estTokens)
      if (deps.compact && effectiveTokens > 0) {
        const before = msgs.length
        const compacted = await deps.compact(msgs, effectiveTokens)
        if (compacted !== msgs) {
          msgs.length = 0
          msgs.push(...compacted)
          emit({ kind: "compaction", tokensBefore: effectiveTokens, messagesBefore: before, messagesAfter: msgs.length })
        }
      }
      continue
    }

    // Final answer (or forced answer on the last turn).
    const draft = text.trim()

    // RECOVERABLE-FAILURE nudge: the model is about to give up right after its LAST action
    // FAILED — without following the recovery the error itself spelled out. Weak models quit
    // after one failure (2026-06-10: guessed slug "NOTION_GET_PAGE_CONTENT"; then passed a page
    // NAME where a UUID id was required — both errors said exactly how to fix it). Force ONE
    // recovery attempt. Read-safe: skipped entirely if any successful WRITE already ran, so it
    // can never re-execute an irreversible action.
    if (!badSlugNudged && !lastTurn) {
      const real = toolCalls.filter((c) => c.name !== "update_plan")
      const last = real[real.length - 1]
      const failedish = (c: typeof last) => {
        if (!c) return false
        if (c.error != null) return true
        const r: any = c.result
        if (r && typeof r === "object") {
          if (r.successful === false) return true
          const e = r.error
          if (typeof e === "string" && e.trim()) return true
          if (e && typeof e === "object" && (e.message || e.error)) return true
        }
        return false
      }
      // Also: ENDING A TASK TURN WITH ZERO TOOL ATTEMPTS and no question back to the user.
      // The classic failure: memory recalled an OLD failure ("the tool requires a specific
      // format…") and the model parrots it instead of trying — phrasings vary endlessly, so
      // don't pattern-match the excuse; challenge the *shape*. Legit zero-tool answers (from
      // the conversation's own prior results) just restate and pass on the second round;
      // clarifying questions are exempt via the "?" check.
      const zeroToolFinal = real.length === 0 && draft.length > 0 && !draft.trim().endsWith("?")
      if (failedish(last) || zeroToolFinal) {
        const wrote = toolCalls.some((c) => {
          if (c.error) return false
          try { return isDestructiveCall({ name: c.name, args: c.args }) } catch { return false }
        })
        if (!wrote) {
          badSlugNudged = true
          // role:"user", not "system": gemini-class models largely ignore mid-conversation
          // system messages — as a user-role note the instruction actually lands.
          msgs.push({
            role: "user",
            content:
              "[automatic check — not the user speaking] " +
              (zeroToolFinal
                ? "You made NO tool attempt this turn. If the conversation above already contains everything needed for your answer, simply restate it and it will stand. Otherwise — and for ANYTHING live (a page, email, calendar, file) — use your tools NOW: search the app for the item BY NAME, take the real id from the result, and do the task. A remembered past failure is not an attempt."
                : "Your last tool call FAILED and its error says exactly how to fix it. Do NOT answer me yet. " +
                  "If the tool name was wrong: call search_tools with a plain description and use the EXACT name it returns. " +
                  "If an argument was wrong (e.g. an id must be a UUID): first search the app for the item BY NAME, take the real id from the result, then retry the call with it. " +
                  "Do the corrected call now."),
          })
          continue
        }
      }
    }

    const finalText = draft || deps.emptyFallback || EMPTY_FALLBACK

    // ── Grounded verify gate (text-only correction; NEVER re-executes) ─────────
    // Before this claim stands, check it is supported by the tool ledger. If it is
    // NOT, we do NOT run another tool round: re-running risked DOUBLE-EXECUTING a
    // write that already succeeded (double-send/charge) and an empty round that
    // erased the real answer. Instead we REPLACE the spoken text with the verifier's
    // grounded restatement (or an honest hedge). Runs on EVERY tool turn, including
    // the final/forced one. The streamed (optimistic) text, if any, is superseded by
    // this return value (the conductor speaks the corrected text; on a write turn the
    // claim was held back, on a read turn a short follow-up corrects it).
    // Runs on EVERY turn with a draft — even zero-tool turns: the verifier's deterministic
    // promissory check catches "I'm going to create it…" finals where nothing was done at all
    // (its LLM grounding pass still only fires when external tools actually ran).
    if (deps.verify && draft) {
      let v: { ok: boolean; concern?: string; correction?: string } | null = null
      try { v = await deps.verify({ finalText, toolCalls }) } catch { v = null }
      if (v && v.ok === false) {
        emit({ kind: "self_correct", concern: v.concern ?? "the reply was not supported by the tool results" })
        const corrected = v.correction && v.correction.trim()
          ? v.correction.trim()
          : `Actually — I'm not fully certain about that${v.concern ? ` (${v.concern})` : ""}, so I won't assume it. Want me to double-check?`
        emit({ kind: "final", text: corrected })
        return { finalText: corrected, toolCalls, turns: turn, stopped: "final", plan: lastPlan, corrected: true }
      }
    }

    emit({ kind: "final", text: finalText })
    return {
      finalText,
      toolCalls,
      turns: turn,
      stopped: calls.length > 0 && lastTurn ? "max_turns" : "final",
      plan: lastPlan,
      corrected: false,
    }
  }

  const finalText = deps.emptyFallback || EMPTY_FALLBACK
  emit({ kind: "final", text: finalText })
  return { finalText, toolCalls, turns: maxTurns, stopped: "max_turns", plan: lastPlan, corrected: false }
}

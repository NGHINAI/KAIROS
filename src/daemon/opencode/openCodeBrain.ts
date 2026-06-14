// openCodeBrain.ts — the warm `opencode` agent as a KAIROS PlannerRunner. This is
// the brain-swap seam (replaces the shelved codex driver): the conductor injects
// `deps.runPlanner = brain.run` (conductor.ts:663); OpenCodeBrain emits the SAME
// LoopEvent shapes as the in-house defaultPlannerRunner, so the conductor's
// onEvent→controller→activity wiring, persistence, and trajectory hooks are untouched.
//
// Per turn: ensure warm opencode (createOpencode, reused) → session per conversation
// (reused) → session.prompt (BLOCKS until idle, returns the final message) while a
// global event subscriber streams parts → LoopEvents (openCodeEvents) → POST-TURN
// verifier gate (verifier.ts, ported) → corrective retry as a NEW prompt (write-guard
// C12). Codex lessons baked in: events route by sessionID (no stale-turn truncation);
// a per-turn WATCHDOG races the blocking prompt so a hung/silent turn can never wedge
// the voice loop; session.error is terminal.
//
// opencode exposes MCP tools as FLAT Chat-Completions function tools, so ANY OpenRouter
// model (minimax) can call them — the capability codex lacked (docs 17/18).

import { createOpenCodeTurnAccumulator, unwrapOpenCodeEvent, type OpenCodeToolCall } from "./openCodeEvents"
import { isDestructiveCall } from "../agents/loop/verifier"
import type { LoopEvent, LoopMsg } from "../agents/loop/types"

// ── history → system (D2 cross-turn memory + D5 cacheable prefix) ──────────────

/** Render durable replay history (LoopMsg[]) into a compact transcript for the per-turn
 *  system. FRESH session per turn means opencode has no cross-turn memory of its own, so
 *  this is KAIROS's authoritative continuity channel (D2 — "reply to that email" chaining).
 *  Skips system messages (the live system prompt is separate); caps to the most RECENT. */
export function renderHistoryForOpenCode(history: LoopMsg[] | undefined, maxChars = 8000): string {
  if (!history?.length) return ""
  const lines: string[] = []
  for (const m of history) {
    if (m.role === "system") continue
    if (m.role === "user") lines.push(`User: ${m.content ?? ""}`)
    else if (m.role === "assistant") {
      const calls = m.tool_calls?.map((c) => c.function?.name).filter(Boolean) ?? []
      lines.push(`Assistant: ${m.content ?? ""}${calls.length ? ` [called: ${calls.join(", ")}]` : ""}`)
    } else if (m.role === "tool") lines.push(`Tool result: ${String(m.content ?? "").slice(0, 600)}`)
  }
  const text = lines.join("\n")
  return text.length > maxChars ? text.slice(text.length - maxChars) : text
}

/** Build the per-turn system: STABLE instructions FIRST (a cacheable prefix the provider
 *  can prompt-cache across turns — D5), then the VOLATILE recent-conversation block. */
export function buildTurnSystem(instructions: string, history: LoopMsg[] | undefined): string {
  const hist = renderHistoryForOpenCode(history)
  return hist ? `${instructions}\n\n## Recent conversation (for context)\n${hist}` : instructions
}

// ── the SDK seam (injected for tests; real impl = spawnOpenCode below) ─────────

export interface OpenCodeHandle {
  /** Create a session, return its id. */
  createSession(): Promise<string>
  /** Send a turn; BLOCKS until the turn completes. Events stream via onEvent. */
  prompt(o: { sessionID: string; text: string; system?: string; model: { providerID: string; modelID: string } }): Promise<{ finalText?: string }>
  /** Abort the active turn on a session (barge-in / watchdog). */
  abort(sessionID: string): Promise<void>
  /** Register the global event handler (every opencode event, wrapped). Called once. */
  onEvent(handler: (raw: any) => void): void
  /** Respond "always" to a permission request (unattended auto-allow). */
  respondPermission(sessionID: string, permissionID: string): Promise<void>
  close(): void
}

export interface OpenCodeVerifier {
  verify(o: { utterance: string; finalText: string; toolCalls: OpenCodeToolCall[] }): Promise<{
    ok: boolean
    concern?: string
    correction?: string
    severity: "read" | "write"
    retryable?: boolean
  }>
}

export interface OpenCodeBrainDeps {
  connect: () => Promise<OpenCodeHandle> | OpenCodeHandle
  modelProviderID: string
  modelID: string
  /** The MCP server name we registered KAIROS tools under (for prefix stripping). */
  mcpServerName: string
  /** Durable persona/doctrine → the per-turn system prompt when a turn provides none. */
  baseInstructions: string
  verifier?: OpenCodeVerifier
  log?: (m: string) => void
  /** Per-turn watchdog deadline (ms). A turn that neither completes nor goes idle by
   *  then is aborted + returns a best-effort final, so the loop can't wedge. */
  turnTimeoutMs?: number
  /** Metering sink (D3) — opencode makes the model calls (bypassing OpenRouterAdapter),
   *  so the brain reports each turn's token/cost usage here → the daemon's llm_call_log. */
  onUsage?: (u: { model?: string; tokensIn: number; tokensOut: number; cost: number; latencyMs: number }) => void
}

export interface OpenCodeRunOpts {
  tools: any[]
  instructions: string
  signal?: AbortSignal
  onEvent?: (e: LoopEvent) => void
  history?: LoopMsg[]
  conversationId?: string
}

export interface OpenCodeRunResult {
  finalOutput: string
  streamedText?: string
  corrected?: boolean
  toolCalls: OpenCodeToolCall[]
}

interface ActiveTurn { sessionID: string; acc: ReturnType<typeof createOpenCodeTurnAccumulator> }

export function createOpenCodeBrain(deps: OpenCodeBrainDeps) {
  const log = deps.log ?? (() => {})
  const turnTimeoutMs = deps.turnTimeoutMs ?? 120_000

  let handle: OpenCodeHandle | null = null
  let connectPromise: Promise<OpenCodeHandle> | null = null
  // The set of LIVE turns. Each event is delivered to EVERY live accumulator, which
  // self-filters by sessionID — so concurrent/overlapping turns (barge-in supersede)
  // can't clobber each other (review CRITICAL #1 + the two HIGHs on the single `active`
  // ref). Fresh session per turn (below) makes the sessionID filter airtight.
  const activeTurns = new Set<ActiveTurn>()

  function ensureConnected(): Promise<OpenCodeHandle> {
    if (handle) return Promise.resolve(handle)
    if (!connectPromise) {
      connectPromise = Promise.resolve(deps.connect()).then((h) => {
        handle = h
        // ONE event router — fan every event out to all live accumulators (each
        // self-filters by sessionID) + auto-allow permission for the matching session.
        // Uses the SAME unwrap as the accumulator so sync-wrapped events are seen (HIGH).
        h.onEvent((raw) => {
          for (const t of activeTurns) { try { t.acc.handle(raw) } catch (e) { log(`openCodeBrain: acc error: ${String((e as Error)?.message ?? e)}`) } }
          const { type, properties } = unwrapOpenCodeEvent(raw)
          if (type === "permission.updated" && properties?.id) {
            const sid = properties?.sessionID ?? properties?.info?.sessionID
            if (sid && [...activeTurns].some((t) => t.sessionID === sid)) {
              h.respondPermission(sid, properties.id).catch((e) => log(`openCodeBrain: permission respond failed: ${String((e as Error)?.message ?? e)}`))
            }
          }
        })
        return h
      }).catch((e) => { connectPromise = null; throw e })
    }
    return connectPromise
  }

  /** Drive ONE turn to completion / abort / timeout, streaming events live. */
  async function runOneTurn(h: OpenCodeHandle, sessionID: string, text: string, system: string, opts: OpenCodeRunOpts): Promise<{
    finalText: string; streamedText: string; toolCalls: OpenCodeToolCall[]; outcome: "completed" | "timeout" | "aborted" | "error"
  }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    let resolveTerminal: (() => void) | undefined
    const acc = createOpenCodeTurnAccumulator({
      sessionID, mcpServerName: deps.mcpServerName, emit: (e) => opts.onEvent?.(e),
      // Race session.ERROR so an errored turn ends immediately instead of hanging to the
      // watchdog (review CRITICAL #2). We do NOT race session.idle — idle normally
      // coincides with prompt() returning, and letting idle win would drop prompt()'s
      // authoritative clean finalText; the watchdog covers the (degenerate) idle-without-
      // prompt-return case.
      onTerminal: (s) => { if (s === "error") resolveTerminal?.() },
    })
    const myTurn: ActiveTurn = { sessionID, acc }
    activeTurns.add(myTurn)
    const t0 = Date.now()

    // Construct the terminal + abort racers BEFORE dispatching the prompt: events can
    // arrive synchronously during prompt() (the SSE pump / tests), so resolveTerminal +
    // onAbort must already be wired or an early session.error is lost (microtask race).
    const terminalP = new Promise<"error">((res) => { resolveTerminal = () => res("error") })
    const abortP = new Promise<"aborted">((res) => {
      if (opts.signal?.aborted) return res("aborted")
      onAbort = () => res("aborted")
      opts.signal?.addEventListener?.("abort", onAbort, { once: true })
    })
    const watchdogP = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), turnTimeoutMs); (timer as any)?.unref?.() })

    let promptResult: { finalText?: string } | undefined
    const promptP = h.prompt({ sessionID, text, system, model: { providerID: deps.modelProviderID, modelID: deps.modelID } })
      .then((r) => { promptResult = r; return "completed" as const })
      .catch((e) => { log(`openCodeBrain: prompt error: ${String((e as Error)?.message ?? e)}`); return "error" as const })

    const outcome = await Promise.race([promptP, watchdogP, abortP, terminalP])
    if (timer) clearTimeout(timer)
    try { if (onAbort) opts.signal?.removeEventListener?.("abort", onAbort) } catch { /* */ }
    // On a non-clean exit, abort the session so opencode stops working the turn.
    if (outcome !== "completed") { try { await h.abort(sessionID) } catch { /* */ } }
    // Swallow the dangling prompt promise if it ever settles later (timeout/abort path).
    void promptP.catch(() => {})
    activeTurns.delete(myTurn)
    acc.close()   // a late trailing event can't mutate this finished turn
    const st = acc.state()
    // D3 metering — report this opencode turn's token/cost spend (it bypasses OpenRouterAdapter).
    if (st.usage && deps.onUsage) { try { deps.onUsage({ ...st.usage, latencyMs: Date.now() - t0 }) } catch { /* never break the turn */ } }
    // finalText: prefer prompt()'s returned FINAL message text (a single clean answer)
    // whenever prompt resolved, over the streamed concatenation; else the accumulator.
    const finalText = promptResult?.finalText || st.finalText
    return { finalText, streamedText: st.streamedText, toolCalls: st.toolCalls, outcome }
  }

  function destructiveAlreadySucceeded(ledger: OpenCodeToolCall[]): boolean {
    return ledger.some((c) => isDestructiveCall(c as any) && !c.error)
  }

  async function run(input: string, opts: OpenCodeRunOpts): Promise<OpenCodeRunResult> {
    try {
      const h = await ensureConnected()
      // FRESH session per turn (review CRITICAL #1): a unique sessionID per turn makes
      // the accumulator's sessionID filter airtight, so a superseded turn's trailing
      // events (same conversation) can never pollute the next turn. The opencode SERVER
      // stays warm; only the (cheap) session is new. Cross-turn memory is KAIROS-
      // authoritative (history injection is a tracked follow-up; opts.history not yet sent).
      const sessionID = await h.createSession()
      // STABLE instructions prefix + VOLATILE history block (D2 cross-turn memory via the
      // fresh session, D5 cacheable-prefix ordering for provider-side prompt caching).
      const baseSystem = opts.instructions && opts.instructions.length ? opts.instructions : deps.baseInstructions
      const system = buildTurnSystem(baseSystem, opts.history)

      const turn = await runOneTurn(h, sessionID, input, system, opts)
      let finalOutput = turn.finalText
      let ledger = turn.toolCalls
      let corrected = false

      // Quiet-abort: a superseded/aborted turn ends without a verifier pass.
      if (turn.outcome === "aborted" || opts.signal?.aborted) {
        return { finalOutput, streamedText: turn.streamedText, corrected: false, toolCalls: ledger }
      }
      // Error/timeout: best-effort partial — no verifier (the answer is incomplete), but
      // return cleanly (never hang). The conductor speaks the partial or its fallback.
      if (turn.outcome === "error" || turn.outcome === "timeout") {
        return { finalOutput, streamedText: finalOutput, corrected: false, toolCalls: ledger }
      }

      // POST-TURN verifier gate (ported). Only on a CLEAN completion. Corrective retry =
      // a NEW prompt (write-guarded); adopt it only if it completed cleanly + not aborted.
      if (deps.verifier && turn.outcome === "completed") {
        try {
          const v = await deps.verifier.verify({ utterance: input, finalText: finalOutput, toolCalls: ledger })
          if (!v.ok && v.retryable && !destructiveAlreadySucceeded(ledger) && !opts.signal?.aborted) {
            opts.onEvent?.({ kind: "self_correct", concern: v.concern ?? "" })
            const followUp = `[automatic check] ${v.concern ?? "re-check your last answer against what the tools actually returned and correct it."}`
            const corr = await runOneTurn(h, sessionID, followUp, system, opts)
            if (corr.outcome === "completed" && !opts.signal?.aborted) {   // only adopt a clean correction
              if (corr.finalText) finalOutput = corr.finalText
              ledger = ledger.concat(corr.toolCalls)
              corrected = true
            }
          } else if (!v.ok && v.correction && !v.retryable) {
            finalOutput = v.correction
            corrected = true
          }
        } catch (e) { log(`openCodeBrain: verifier error (not blocking): ${String((e as Error)?.message ?? e)}`) }
      }

      // Read-tier double-speak guard (review HIGH): the conductor re-speaks the final
      // when it differs from what streamed live. streamedText (accumulator concat) and
      // finalOutput (prompt's final message) diverge structurally, so report streamedText
      // == finalOutput on an UNCORRECTED turn (the live stream already said it); on a
      // CORRECTED turn keep them divergent so the corrected reply is spoken.
      const streamedOut = corrected ? turn.streamedText : finalOutput
      return { finalOutput, streamedText: streamedOut, corrected, toolCalls: ledger }
    } catch (e) {
      log(`openCodeBrain: run failed: ${String((e as Error)?.message ?? e)}`)
      return { finalOutput: "", streamedText: "", corrected: false, toolCalls: [] }
    }
  }

  function shutdown(): void {
    try { handle?.close() } catch { /* */ }
    handle = null; connectPromise = null; activeTurns.clear()
  }

  return { run, shutdown }
}

// ── the real SDK adapter (not unit-tested; validated by the live E2E, B3) ──────

/** Build the opencode config object (passed to createOpencode — no file needed):
 *  OpenRouter(minimax) provider via @ai-sdk/openai-compatible + KAIROS's in-daemon /mcp
 *  as a remote MCP server + permissive permissions (we auto-respond anyway). */
export function buildOpenCodeConfig(o: {
  brainKey: string
  baseURL: string
  modelProviderID: string
  modelID: string
  mcpServerName: string
  mcpUrl: string
  mcpToken: string
}): any {
  return {
    provider: {
      [o.modelProviderID]: {
        npm: "@ai-sdk/openai-compatible",
        name: "KAIROS Brain",
        options: { baseURL: o.baseURL, apiKey: o.brainKey },
        models: { [o.modelID]: { name: o.modelID, tool_call: true } },
      },
    },
    mcp: {
      [o.mcpServerName]: {
        type: "remote",
        url: o.mcpUrl,
        headers: { authorization: `Bearer ${o.mcpToken}` },
        enabled: true,
      },
    },
    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
  }
}

/** Spawn a warm opencode (createOpencode → opencode serve + HTTP client) and adapt the
 *  SDK to OpenCodeHandle. Reads minimal config; the client talks loopback HTTP+SSE. */
export async function spawnOpenCode(o: { config: any; log?: (m: string) => void }): Promise<OpenCodeHandle> {
  const log = o.log ?? (() => {})
  const { createOpencode } = await import("@opencode-ai/sdk")
  const { client, server } = await createOpencode({ config: o.config })
  log(`opencode serve up at ${server.url}`)
  let handler: (raw: any) => void = () => {}
  let closed = false
  // Background: pump the global SSE stream → handler, in a RECONNECT loop (review HIGH).
  // If the stream ends/throws (server hiccup, socket drop, idle timeout), we must
  // re-establish it — otherwise every subsequent turn silently receives zero events.
  void (async () => {
    let backoff = 200
    while (!closed) {
      try {
        const ev = await client.global.event()
        backoff = 200
        for await (const e of ev.stream) { if (closed) return; handler(e) }
      } catch (e) { log(`opencode event stream error: ${String((e as Error)?.message ?? e)}`) }
      if (closed) return
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 5000)
    }
  })()
  return {
    createSession: async () => {
      const r: any = await client.session.create({ body: { title: "kairos" } })
      const id = r?.data?.id ?? r?.id
      if (!id) throw new Error("opencode session.create returned no id")
      return id
    },
    prompt: async ({ sessionID, text, system, model }) => {
      const res: any = await client.session.prompt({ path: { id: sessionID }, body: { model, parts: [{ type: "text", text }], ...(system ? { system } : {}) } } as any)
      // prompt() returns the FINAL assistant message — its text part(s) are the clean
      // single answer (no prompt-echo, no cross-step duplication).
      const parts = res?.data?.parts ?? res?.parts ?? []
      const finalText = parts.filter((p: any) => p?.type === "text").map((p: any) => p.text ?? "").join("")
      return { finalText }
    },
    abort: async (sessionID) => { try { await client.session.abort({ path: { id: sessionID } } as any) } catch { /* */ } },
    onEvent: (h) => { handler = h },
    respondPermission: async (sessionID, permissionID) => {
      // The permission-respond method lives on the ROOT client, NOT client.session
      // (review HIGH — the old client.session.* call threw, silently stalling the turn).
      await (client as any).postSessionIdPermissionsPermissionId({ path: { id: sessionID, permissionID }, body: { response: "always" } })
    },
    close: () => { closed = true; try { server.close() } catch { /* */ } },
  }
}

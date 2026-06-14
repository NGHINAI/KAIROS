// openCodeEvents.ts — translate the opencode SSE event stream into the daemon's
// existing LoopEvent pipeline (loop/types.ts — the STABLE seam) and reconstruct the
// (finalText, toolCalls ledger, status) tuple the post-turn verifier consumes.
// Contract captured live from opencode 1.17.6 (docs/clicky-migration/18):
//   • events are wrapped: real event = raw.payload.{type, properties}
//   • message.part.updated carries a part; text/reasoning parts are CUMULATIVE
//     (assistant_delta = the NEW suffix vs the last-seen text for that part id)
//   • tool parts carry the whole lifecycle in state.status (pending→running→
//     completed|error), with state.input (args) + state.output (result string)
//   • every turn event carries sessionID → route by it (the codex stale-turn lesson:
//     a late event from another turn/session can never pollute this turn)
//   • session.idle / session.error are terminal signals
//   • MCP tool names are "<server>_<tool>" — strip the known server prefix so the
//     verifier sees the bare action (the A3 namespace-strip invariant).

import type { LoopEvent } from "../agents/loop/types"

export interface OpenCodeToolCall {
  id: string
  name: string
  args: any
  result?: any
  error?: string
}

export interface OpenCodeTurnUsage {
  model?: string
  tokensIn: number
  tokensOut: number
  reasoningTokens: number
  cost: number
}

export interface OpenCodeTurnState {
  finalText: string
  streamedText: string
  toolCalls: OpenCodeToolCall[]
  status?: "idle" | "error"
  errorMessage?: string
  /** Token/cost usage for the turn (summed across assistant messages) — for metering (D3). */
  usage?: OpenCodeTurnUsage
}

/** Strip the known MCP server prefix from an opencode tool name. opencode namespaces
 *  MCP tools as `<server>_<tool>` (single underscore); we control the server name, so
 *  we strip exactly that prefix → the bare action name the verifier expects. */
export function stripMcpPrefix(name: string, serverName: string): string {
  if (!name || !serverName) return name
  const pfx = `${serverName}_`
  return name.startsWith(pfx) ? name.slice(pfx.length) : name
}

/** Unwrap opencode's event envelope. Real event is at .payload; tolerate an already
 *  unwrapped {type, properties}. Sync-wrapped events expose the inner via syncEvent.
 *  EXPORTED so the brain's router uses the SAME unwrap (sync-wrapped permission.updated
 *  / terminal events must be seen consistently — review HIGH). */
export function unwrapOpenCodeEvent(raw: any): { type?: string; properties?: any } {
  const p = raw?.payload ?? raw
  if (p && p.type === "sync" && p.syncEvent) return { type: p.syncEvent.type, properties: p.syncEvent.data ?? p.syncEvent }
  return { type: p?.type, properties: p?.properties }
}

function partSessionId(part: any, props: any): string | undefined {
  return part?.sessionID ?? props?.sessionID
}

/** A stateful per-turn accumulator scoped to ONE opencode session. Feed it raw events;
 *  it emits LoopEvents for THIS session only and builds the verifier tuple. */
export function createOpenCodeTurnAccumulator(opts: {
  sessionID: string
  mcpServerName: string
  emit: (e: LoopEvent) => void
  /** Fired ONCE when this session reaches a terminal state (session.idle | session.error).
   *  Lets the driver race terminal state so an errored/idle turn can't hang run(). */
  onTerminal?: (status: "idle" | "error") => void
}) {
  const state: OpenCodeTurnState = { finalText: "", streamedText: "", toolCalls: [] }
  let closed = false       // set when the turn ends — a late event can't mutate finished state
  // Per-part cumulative text seen so far (text parts), to compute deltas.
  const textByPart = new Map<string, string>()
  const textOrder: string[] = []
  // messageID → role (from message.updated). Lets us drop the USER message's echoed
  // text part — opencode streams the prompt back as a text part too (prompt-echo bug).
  const roleByMsg = new Map<string, string>()
  // messageID → latest usage snapshot (message.updated repeats; keep the latest per msg,
  // sum across distinct assistant messages for the turn total — D3 metering).
  const usageByMsg = new Map<string, { tokensIn: number; tokensOut: number; reasoningTokens: number; cost: number; model?: string }>()
  function recomputeUsage() {
    let tokensIn = 0, tokensOut = 0, reasoningTokens = 0, cost = 0, model: string | undefined
    for (const u of usageByMsg.values()) { tokensIn += u.tokensIn; tokensOut += u.tokensOut; reasoningTokens += u.reasoningTokens; cost += u.cost; model = u.model ?? model }
    state.usage = { tokensIn, tokensOut, reasoningTokens, cost, model }
  }
  // Tool parts: id → ledger entry; started set guards a single tool_call_start.
  const toolById = new Map<string, OpenCodeToolCall>()
  const started = new Set<string>()

  function recomputeFinal() {
    state.finalText = textOrder.map((id) => textByPart.get(id) ?? "").join("")
    state.streamedText = state.finalText
  }

  function onTextPart(part: any) {
    // Drop the USER message's echoed prompt (opencode streams it as a text part too).
    if (part.messageID && roleByMsg.get(String(part.messageID)) === "user") return
    const id = String(part.id)
    const full = String(part.text ?? "")
    const prev = textByPart.get(id) ?? ""
    if (!textByPart.has(id)) textOrder.push(id)
    if (full.length > prev.length && full.startsWith(prev)) {
      const delta = full.slice(prev.length)
      textByPart.set(id, full)
      if (delta) opts.emit({ kind: "assistant_delta", text: delta })
    } else if (full !== prev) {
      // non-append rewrite (rare) — update the accumulated text but do NOT re-emit to
      // live TTS (re-speaking the whole text would double it); finalText carries it.
      textByPart.set(id, full)
    }
    recomputeFinal()
  }

  function onToolPart(part: any) {
    const id = String(part.id)
    const name = stripMcpPrefix(String(part.tool ?? ""), opts.mcpServerName)
    const status = part.state?.status
    const args = part.state?.input ?? {}
    let call = toolById.get(id)
    if (!call) { call = { id, name, args }; toolById.set(id, call); state.toolCalls.push(call) }
    call.args = args
    // tool_call_start ONCE (first pending/running sighting)
    if ((status === "pending" || status === "running") && !started.has(id)) {
      started.add(id)
      opts.emit({ kind: "tool_call_start", id, name, args })
      return
    }
    if (status === "completed") {
      if (!started.has(id)) { started.add(id); opts.emit({ kind: "tool_call_start", id, name, args }) }
      call.result = part.state?.output ?? ""
      opts.emit({ kind: "tool_call_done", id, name, result: call.result })
    } else if (status === "error") {
      if (!started.has(id)) { started.add(id); opts.emit({ kind: "tool_call_start", id, name, args }) }
      call.error = String(part.state?.error ?? "tool error")
      opts.emit({ kind: "tool_call_failed", id, name, error: call.error })
    }
  }

  function handle(raw: any): void {
    if (closed) return
    const { type, properties } = unwrapOpenCodeEvent(raw)
    if (!type) return
    switch (type) {
      case "message.updated": {
        // Record role per messageID (opencode sends this BEFORE the message's parts),
        // so onTextPart can drop the user message's echoed prompt. opencode's real shape
        // is EventMessageUpdated.properties = { info: Message } — sessionID + role live on
        // `info`, NOT top-level (review CRITICAL #3). Read from info (fall back to a
        // top-level sessionID defensively).
        const info = properties?.info
        const sid = info?.sessionID ?? properties?.sessionID
        if (sid === opts.sessionID && info?.id) {
          roleByMsg.set(String(info.id), String(info.role ?? ""))
          // AssistantMessage carries per-message token usage + cost — capture latest.
          if (info.role === "assistant" && info.tokens) {
            usageByMsg.set(String(info.id), {
              tokensIn: Number(info.tokens.input ?? 0), tokensOut: Number(info.tokens.output ?? 0),
              reasoningTokens: Number(info.tokens.reasoning ?? 0), cost: Number(info.cost ?? 0), model: info.modelID,
            })
            recomputeUsage()
          }
        }
        return
      }
      case "message.part.updated": {
        const part = properties?.part
        if (!part) return
        if (partSessionId(part, properties) !== opts.sessionID) return   // id-match: ignore other sessions
        if (part.type === "text") onTextPart(part)
        else if (part.type === "tool") onToolPart(part)
        // reasoning / step-start / step-finish → no LoopEvent (thinking/structure, not spoken)
        return
      }
      case "session.idle":
        if (properties?.sessionID === opts.sessionID && !state.status) { state.status = "idle"; opts.onTerminal?.("idle") }
        return
      case "session.error":
        if (properties?.sessionID === opts.sessionID && !state.status) {
          state.status = "error"
          state.errorMessage = String(properties?.error?.message ?? properties?.error ?? "session error")
          opts.onTerminal?.("error")
        }
        return
      default:
        return
    }
  }

  return {
    handle,
    isTerminal: () => state.status === "idle" || state.status === "error",
    state: () => state,
    /** Stop accepting events — the turn is over (defense-in-depth vs late events). */
    close: () => { closed = true },
  }
}

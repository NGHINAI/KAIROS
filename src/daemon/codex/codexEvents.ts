// codexEvents.ts — translate the codex app-server notification stream into the
// daemon's existing `LoopEvent` pipeline (the STABLE seam — loop/types.ts:36-46)
// and reconstruct the (finalText, toolCalls ledger, plan, status) tuple the
// post-turn verifier consumes (verifier.ts). Codex's event stream yields exactly
// that tuple, so the gate ports without a rewrite (doc 01 §D, 09).
//
// A3 invariant (hard, tested): the MCP namespace is stripped from every tool name
// BEFORE it lands in the ledger — so `isDestructiveCall`/`effectiveName` see the
// bare action ("GMAIL_SEND_EMAIL", not "kairos__GMAIL_SEND_EMAIL") and a Composio
// write can never masquerade as a local/safe tool, silently disabling the gate.

import type { LoopEvent } from "../agents/loop/types"

/** A reconstructed tool call for the verifier ledger (same shape the in-house loop
 *  produces). `name` is the BARE, namespace-stripped action; `execute_tool` wrapping
 *  is left intact (the verifier's effectiveName unwraps args.tool_name itself). */
export interface CodexToolCall {
  id: string
  name: string
  args: any
  result?: any
  error?: string
}

export interface CodexTurnState {
  /** Authoritative final answer (from the completed agentMessage item). */
  finalText: string
  /** What was actually streamed to TTS live (delta accumulation) — may differ from
   *  finalText after a verify-gate correction. */
  streamedText: string
  toolCalls: CodexToolCall[]
  plan?: Array<{ step: string; status: string }>
  status?: string
}

/** Strip the MCP server namespace from a tool name. Codex namespaces tools as
 *  `<server>__<tool>` in the model's function list; the structured mcpToolCall item
 *  usually splits them, but we strip defensively so a leaked `kairos__`/`kairos.`
 *  prefix can never reach the destructive-gate (A3). */
export function stripMcpNamespace(name: string): string {
  if (!name) return name
  const us = name.indexOf("__")
  if (us > 0) return name.slice(us + 2)
  const dot = name.indexOf(".")
  if (dot > 0 && name.slice(0, dot) === "kairos") return name.slice(dot + 1)
  return name
}

/** Join an MCP tool result's text content back into the string the in-house tools
 *  returned (our MCP server wraps `ToolDef.execute`'s string in content[].text), so
 *  the verifier's grounding checks (startsWith("Pointing at"), etc.) keep working.
 *  Accepts the full McpToolCallResult shape (+ structuredContent/_meta) or a bare
 *  {content} so callers can pass either the proto object or a stub. */
export function mcpResultText(result: { content?: any[]; [k: string]: any } | null | undefined): string {
  if (!result || !Array.isArray(result.content)) return ""
  return result.content
    .map((c: any) => (c && typeof c === "object" && typeof c.text === "string" ? c.text : ""))
    .join("")
}

// Tool-ish ThreadItem types that map onto our tool-call LoopEvents. agentMessage /
// reasoning / plan / contextCompaction are NOT tool calls.
const TOOLISH = new Set(["mcpToolCall", "commandExecution", "fileChange", "webSearch"])

/** The bare action name for a tool-ish item. */
function itemToolName(item: any): string {
  switch (item?.type) {
    case "mcpToolCall": return stripMcpNamespace(String(item.tool ?? ""))
    case "commandExecution": return "run_shell"
    case "fileChange": return "edit_file"
    case "webSearch": return "web_search"
    default: return stripMcpNamespace(String(item?.tool ?? item?.type ?? ""))
  }
}

function itemArgs(item: any): any {
  switch (item?.type) {
    case "mcpToolCall": return item.arguments ?? {}
    case "commandExecution": return { command: item.command }
    case "webSearch": return { query: item.query }
    default: return {}
  }
}

/** Did a completed tool-ish item fail? */
function itemError(item: any): string | undefined {
  if (item?.type === "mcpToolCall") return item.error ? String(item.error.message ?? item.error) : undefined
  if (item?.type === "commandExecution") return typeof item.exitCode === "number" && item.exitCode !== 0 ? `exit ${item.exitCode}` : undefined
  if (item?.status === "failed") return "failed"
  return undefined
}

/** The string result for a completed tool-ish item. */
function itemResult(item: any): any {
  if (item?.type === "mcpToolCall") return mcpResultText(item.result)
  if (item?.type === "commandExecution") return String(item.aggregatedOutput ?? "")
  return undefined
}

/** A stateful per-turn accumulator: feed it app-server notification (method, params)
 *  pairs; it emits LoopEvents and builds the verifier tuple. One instance per turn. */
export function createTurnAccumulator(emit: (e: LoopEvent) => void) {
  const state: CodexTurnState = { finalText: "", streamedText: "", toolCalls: [] }
  const byId = new Map<string, CodexToolCall>()

  function startTool(item: any) {
    const id = String(item.id)
    const call: CodexToolCall = { id, name: itemToolName(item), args: itemArgs(item) }
    byId.set(id, call)
    state.toolCalls.push(call)
    emit({ kind: "tool_call_start", id, name: call.name, args: call.args })
  }

  function finishTool(item: any) {
    const id = String(item.id)
    let call = byId.get(id)
    if (!call) {
      // completed without a started (some items only surface once) — synthesize it.
      call = { id, name: itemToolName(item), args: itemArgs(item) }
      byId.set(id, call)
      state.toolCalls.push(call)
    }
    const err = itemError(item)
    if (err) {
      call.error = err
      emit({ kind: "tool_call_failed", id, name: call.name, error: err })
    } else {
      call.result = itemResult(item)
      emit({ kind: "tool_call_done", id, name: call.name, result: call.result })
    }
  }

  function handle(method: string, params: any): void {
    switch (method) {
      case "item/agentMessage/delta": {
        const text = String(params?.delta ?? "")
        if (text) { state.streamedText += text; emit({ kind: "assistant_delta", text }) }
        return
      }
      case "item/started": {
        const item = params?.item
        if (item && TOOLISH.has(item.type)) startTool(item)
        return
      }
      case "item/completed": {
        const item = params?.item
        if (!item) return
        if (item.type === "agentMessage") { state.finalText = String(item.text ?? ""); return }
        if (TOOLISH.has(item.type)) finishTool(item)
        return
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params?.plan) ? params.plan : []
        state.plan = plan
        emit({ kind: "plan_update", plan })
        return
      }
      case "thread/compacted": {
        emit({ kind: "compaction", tokensBefore: 0, messagesBefore: 0, messagesAfter: 0 })
        return
      }
      case "turn/completed": {
        state.status = params?.turn?.status ?? params?.status
        return
      }
      // turn/started, thread/started, item/reasoning/*, token usage → handled by the
      // driver (bookkeeping/metering), not the LoopEvent seam.
      default:
        return
    }
  }

  return { handle, state: () => state }
}

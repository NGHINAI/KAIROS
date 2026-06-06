// src/daemon/agents/loop/types.ts
// Types for the KAIROS Agent Loop (KAL) — our owned, Codex-grade agentic loop
// on the streaming OpenRouterAdapter. Replaces @openai/agents' opaque run() for
// the smart tier so we can stream narration, self-correct on tool errors,
// compact context, and cap turns.

import type { StreamEvent, ToolSchema } from "../../wrapApi/adapters/openRouterAdapter"
import type { ToolDef } from "../types"

/** Chat-completions message shapes, including tool calling. The request must
 *  carry the assistant's tool_calls and a matching tool message per call, or
 *  OpenRouter/OpenAI rejects it. */
export type LoopMsg =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  // content is OPTIONAL on assistant: providers (OpenAI/Kimi) reject an
  // empty-string content alongside tool_calls — omit it on pure tool-call turns.
  | { role: "assistant"; content?: string; tool_calls?: ToolCallWire[] }
  | { role: "tool"; tool_call_id: string; content: string }

export interface ToolCallWire {
  id: string
  type: "function"
  function: { name: string; arguments: string }
}

/** A tool call surfaced by the model this turn. */
export interface ToolCall {
  id: string
  name: string
  argsJson: string
}

/** Live events emitted during a run — consumed by the narrator (Phase 3) and
 *  the trajectory log. */
export type LoopEvent =
  | { kind: "assistant_delta"; text: string }
  | { kind: "tool_call_start"; id: string; name: string; args: any }
  | { kind: "tool_call_done"; id: string; name: string; result: any }
  | { kind: "tool_call_failed"; id: string; name: string; error: string }
  | { kind: "plan_update"; plan: any }
  | { kind: "compaction"; tokensBefore: number; messagesBefore: number; messagesAfter: number }
  // The grounded-verify gate flagged the draft answer; the loop is running one
  // more round to actually perform the claimed action / restate from the ledger.
  | { kind: "self_correct"; concern: string }
  | { kind: "final"; text: string }

/** The streaming LLM the loop drives (OpenRouterAdapter satisfies this). */
export interface LoopLlm {
  stream(body: {
    messages: LoopMsg[]
    model?: string
    max_tokens?: number
    temperature?: number
    tools?: ToolSchema[]
    tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } }
    signal?: AbortSignal
  }): AsyncGenerator<StreamEvent, void, unknown>
}

export interface AgentLoopResult {
  finalText: string
  toolCalls: Array<{ name: string; args: any; result?: any; error?: string }>
  turns: number
  stopped: "final" | "max_turns" | "aborted" | "error"
  /** The last plan the loop saw via update_plan (for trajectory/skill mining). */
  plan?: Array<{ step: string; status: string }>
  /** True if the grounded-verify gate flagged the first answer and the loop ran a
   *  correction round. Lets the speaker know the streamed draft was superseded. */
  corrected?: boolean
}

/** Map our ToolDef[] to the wire tool schema. De-dups by name (last wins) — strict
 *  providers reject duplicate function.name with a 400, which would kill the whole
 *  run; this is the safety net behind callers that should already de-dup. */
export function toolsToSchemas(tools: ToolDef[]): ToolSchema[] {
  const byName = new Map<string, ToolSchema>()
  for (const t of tools) {
    byName.set(t.name, {
      type: "function" as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })
  }
  return [...byName.values()]
}

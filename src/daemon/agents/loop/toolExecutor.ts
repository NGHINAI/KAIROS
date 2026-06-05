// src/daemon/agents/loop/toolExecutor.ts
// Executes one tool call and ALWAYS returns a tool result — never throws to the
// loop. Codex's RespondToModel discipline: malformed args, unknown tools, and
// runtime errors all come back as a `role:'tool'` result so the model can
// self-correct or route around the failure on the next turn. Every tool_call_id
// gets a matching result (even on abort), or chat-completions 400s on an
// orphaned tool call.

import type { ToolDef } from "../types"
import type { ToolCall } from "./types"

export interface ToolResult {
  tool_call_id: string
  content: string
  ok: boolean
  /** Raw result on success — for narration/verification (not sent to the model). */
  result?: any
}

// Cap a tool result so one huge payload can't blow context. Env-configurable.
const MAX_CONTENT = Number(process.env.KAIROS_MAX_TOOL_CHARS) || 16000

/** Truncate with an explicit marker so the model knows it's incomplete (rather
 *  than silently cutting mid-JSON and making the model waste a turn recovering). */
function clamp(content: string, max: number): string {
  if (content.length <= max) return content
  return content.slice(0, max) + `\n…(truncated; showed ${max} of ${content.length} characters)`
}

export async function executeToolCall(
  call: ToolCall,
  tools: ToolDef[],
  opts?: { signal?: AbortSignal; maxChars?: number },
): Promise<ToolResult> {
  if (opts?.signal?.aborted) {
    return { tool_call_id: call.id, content: "Tool call aborted by the user.", ok: false }
  }

  const tool = tools.find((t) => t.name === call.name)
  if (!tool) {
    return {
      tool_call_id: call.id,
      content: `Error: no tool named "${call.name}". Call search_tools to find the right tool name, then try again.`,
      ok: false,
    }
  }

  let args: any = {}
  if (call.argsJson && call.argsJson.trim()) {
    try {
      args = JSON.parse(call.argsJson)
    } catch (e) {
      return {
        tool_call_id: call.id,
        content: `Error: could not parse your arguments as JSON (${(e as Error).message}). Retry the call with valid JSON arguments.`,
        ok: false,
      }
    }
  }

  try {
    const result = await tool.execute(args)
    const content = typeof result === "string" ? result : JSON.stringify(result ?? null)
    return { tool_call_id: call.id, content: clamp(content, opts?.maxChars ?? MAX_CONTENT), ok: true, result }
  } catch (e) {
    return {
      tool_call_id: call.id,
      content: `Error running ${call.name}: ${(e as Error).message}. Try a different approach or tell the user plainly.`,
      ok: false,
    }
  }
}

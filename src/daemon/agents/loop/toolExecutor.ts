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

// Cap a tool result so one huge payload can't blow context. Lowered from 16000 →
// 6000: combined with shaping (below) this cuts a verbose inbox dump from ~16KB to
// ~1–2KB, which is the bulk of the "seeing a lot at once" overload. Env-configurable.
const MAX_CONTENT = Number(process.env.KAIROS_MAX_TOOL_CHARS) || 6000

/** Middle-elision: keep the HEAD and the TAIL with an explicit marker. A plain
 *  head-cut would drop ids that live near the end of a list result; keeping both ends
 *  preserves far more usable structure than a tail-truncate. */
export function clampMiddle(content: string, max: number): string {
  if (content.length <= max) return content
  const head = Math.floor(max * 0.6)
  const tail = Math.max(0, max - head - 60)
  return content.slice(0, head) + `\n…(${content.length - head - tail} chars elided)…\n` + content.slice(content.length - tail)
}

// Fields worth keeping from a list element — ids/handles + the human-meaningful bits.
// Everything else (bodies, payloads, attachmentList, labelIds, raw MIME) is dropped.
const KEEP_FIELDS = ["id", "threadId", "messageId", "from", "sender", "to", "subject", "title", "name", "snippet", "preview", "summary", "date", "timestamp", "status", "state", "url", "permalink"]

/** Shape a verbose LIST/FETCH/SEARCH result down to a compact, id-preserving form
 *  BEFORE it reaches the model. Returns null for non-list results (e.g. a single
 *  send/get) so they pass through untouched. Preserves the threadId — the exact field
 *  the email-reply arc needs — while dropping the multi-KB bodies/payloads. */
export function shapeToolResult(toolName: string, result: any): any | null {
  if (!/(_FETCH|_LIST|_SEARCH|FETCH_EMAILS|LIST_MESSAGES|GET_MESSAGES|SEARCH)/i.test(toolName)) return null
  const data = result?.data ?? result
  const arr =
    data?.messages ?? data?.items ?? data?.results ?? data?.issues ?? data?.threads ?? data?.events ?? (Array.isArray(data) ? data : null)
  if (!Array.isArray(arr) || arr.length === 0) return null
  const items = arr.slice(0, 25).map((it: any) => {
    if (it == null || typeof it !== "object") return it
    const out: Record<string, any> = {}
    for (const k of KEEP_FIELDS) if (it[k] !== undefined) out[k] = typeof it[k] === "string" ? it[k].slice(0, 300) : it[k]
    return out
  })
  return {
    count: arr.length,
    ...(arr.length > items.length ? { showing: items.length } : {}),
    items,
    ...(result?.successful !== undefined ? { successful: result.successful } : {}),
  }
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
    // Shape verbose list/fetch/search results to a compact, id-preserving form for the
    // MODEL (the raw `result` is kept intact for the verify gate + replay persistence).
    const shaped = typeof result === "string" ? null : shapeToolResult(call.name, result)
    const forModel = shaped ?? result
    const content = typeof forModel === "string" ? forModel : JSON.stringify(forModel ?? null)
    return { tool_call_id: call.id, content: clampMiddle(content, opts?.maxChars ?? MAX_CONTENT), ok: true, result }
  } catch (e) {
    return {
      tool_call_id: call.id,
      content: `Error running ${call.name}: ${(e as Error).message}. Try a different approach or tell the user plainly.`,
      ok: false,
    }
  }
}

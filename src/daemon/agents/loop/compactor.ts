// src/daemon/agents/loop/compactor.ts
// Local context compaction (Codex's auto-compact, model-agnostic). When a long
// multi-tool task pushes the token count past a threshold, summarize the history
// and rebuild it as: [system msgs, summary, current plan, the goal, the LAST
// complete tool exchange]. Hardened (R7) over the naive "summary-only" approach:
//   • the SUMMARY carries the dropped middle,
//   • the original GOAL (first user turn) is kept verbatim (not paraphrased away),
//   • the current PLAN (last update_plan) is preserved as a checklist,
//   • the LAST assistant→tool round is kept VERBATIM with tool_call_id pairing
//     intact (the next step usually depends on the most recent result).
// Claude Code keeps the live todo + recent context across compaction for exactly
// this reason. We never keep a tool message without its matching assistant
// tool_calls turn, so no orphaned tool_call_id survives.

import type { LoopMsg } from "./types"

export const COMPACT_PROMPT =
  "You are compacting a conversation so another assistant can resume the task seamlessly. " +
  "Write a tight handoff summary covering: what the user wants, progress and key decisions so far, " +
  "any critical data or results already retrieved (IDs, names, values the next step needs), and what remains to do next. " +
  "Be specific and complete — the next assistant sees your summary plus the goal, the current plan, and the latest tool exchange."

export interface CompactorDeps {
  /** Summarize the history into a handoff string (cheap model). */
  summarize: (messages: LoopMsg[]) => Promise<string>
  /** Compact once token usage exceeds this. Default 24000. */
  thresholdTokens?: number
}

const DEFAULT_THRESHOLD = Number(process.env.KAIROS_COMPACT_AT_TOKENS) || 24000

/** Render the most recent update_plan plan (from an assistant tool_call) as a checklist. */
function extractPlanNote(messages: LoopMsg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: any = messages[i]
    if (m?.role !== "assistant" || !Array.isArray(m.tool_calls)) continue
    const call = m.tool_calls.find((c: any) => c?.function?.name === "update_plan")
    if (!call) continue
    try {
      const args = JSON.parse(call.function.arguments || "{}")
      if (Array.isArray(args.plan) && args.plan.length) {
        const lines = args.plan
          .map((s: any) => `  - [${s?.status === "completed" ? "x" : s?.status === "in_progress" ? "~" : " "}] ${String(s?.step ?? "")}`)
          .join("\n")
        return `Current plan (carry it forward):\n${lines}`
      }
    } catch { /* ignore a malformed plan */ }
    return ""
  }
  return ""
}

/** The LAST complete [assistant-with-tool_calls, ...its tool results] block, kept
 *  verbatim so pairing stays valid. Returns [] if the history has no tool round. */
function lastToolBlock(messages: LoopMsg[]): LoopMsg[] {
  let asstIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    const m: any = messages[i]
    if (m?.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) { asstIdx = i; break }
  }
  if (asstIdx === -1) return []
  const block: LoopMsg[] = [messages[asstIdx]!]
  // Collect the contiguous tool responses that answer this assistant's tool_calls.
  const ids = new Set((messages[asstIdx] as any).tool_calls.map((c: any) => c.id))
  for (let j = asstIdx + 1; j < messages.length; j++) {
    const m: any = messages[j]
    if (m?.role === "tool" && ids.has(m.tool_call_id)) block.push(m)
    else if (m?.role === "tool") continue // a stray tool msg; skip (shouldn't happen)
    else break // hit the next assistant/user/system — block ends
  }
  // Never keep an assistant tool_calls turn whose calls aren't ALL answered — an
  // orphaned tool_call_id makes providers 400. If incomplete, drop the block (the
  // summary still carries it); defends the invariant regardless of caller scheduling.
  const answered = new Set(block.filter((m: any) => m.role === "tool").map((m: any) => m.tool_call_id))
  if (![...ids].every((id) => answered.has(id))) return []
  return block
}

export function buildCompactor(deps: CompactorDeps) {
  const threshold = deps.thresholdTokens ?? DEFAULT_THRESHOLD
  return {
    /** Returns the SAME array (no-op) when under budget, or a rebuilt, compacted history. */
    async maybeCompact(messages: LoopMsg[], tokensIn: number): Promise<LoopMsg[]> {
      if (tokensIn < threshold) return messages

      const summary = await deps.summarize(messages)
      const systemMsgs = messages.filter((m) => m.role === "system")
      // The user GOAL. Within a single runAgentLoop there's exactly one user turn,
      // so last==first==the goal; reverse-find is safe for the foreground too.
      const goalUser = [...messages].reverse().find((m) => m.role === "user")
      const planNote = extractPlanNote(messages)
      const recentBlock = lastToolBlock(messages)

      const rebuilt: LoopMsg[] = [
        ...systemMsgs,
        { role: "system", content: `Summary of the conversation and work so far (you are resuming):\n${summary}` },
        ...(planNote ? [{ role: "system" as const, content: planNote }] : []),
        ...(goalUser ? [goalUser] : []),
        ...recentBlock,
      ]
      return rebuilt
    },
  }
}

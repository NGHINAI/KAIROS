// src/daemon/agents/recallTool.ts
// JIT memory recall for the PLANNER: the per-turn context delta injects memory keyed on
// the user's utterance, but mid-task the agent often discovers it needs something the
// utterance never mentioned ("draft the reply the way she likes" → recall the stored
// style preference). recall_memory lets it pull from long-term memory ON DEMAND with its
// own query, instead of being limited to what the turn's opening keyed in.
//
// Same hygiene as the injected delta: failure-echo hits are dropped (a past failure is
// never a fact about the world), ages are annotated, and the result is TEXT — strings
// pass the tool-result shaper losslessly.

import type { ToolDef } from "./types"
import { isSelfEchoMemory, age } from "./contextBuilder"

export interface RecallToolDeps {
  injector: {
    inject: (
      query: string,
      opts?: { max_l2?: number; max_l3?: number; include_l4?: boolean },
    ) => Promise<Array<{ text: string; source?: string; ts?: number }>>
  }
}

const HIT_MAX = 300   // one hit never dominates the observation (matches the delta budget)

export function buildRecallTool(deps: RecallToolDeps): ToolDef {
  return {
    name: "recall_memory",
    concurrencySafe: true, // read-only → safe alongside other reads
    description:
      "Search the user's long-term memory: durable facts, preferences, past conversations, decisions, and learnings. " +
      "Use this MID-TASK when you need something from the past that isn't in the current context " +
      "(a person's details, a stored preference, what was decided about X, how something was done before). " +
      "Memory is NOT live data — for current email/calendar/app state use the app's tools instead.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you're trying to remember, in plain words (e.g. 'Sam's email address', 'preferred meeting length')" },
      },
      required: ["query"],
    },
    execute: async (args: { query: string }) => {
      const query = String(args?.query ?? "").trim()
      if (!query) return "Give recall_memory a non-empty query describing what to remember."
      let hits: Array<{ text: string; source?: string; ts?: number }> = []
      try {
        hits = await deps.injector.inject(query, { max_l2: 5, max_l3: 8, include_l4: false })
      } catch {
        return "Memory search failed — continue without it."
      }
      const clean = hits.filter((h) => h.text && !isSelfEchoMemory(h.text))
      if (clean.length === 0) {
        return "Nothing relevant in memory for that. Don't invent it — ask the user or use a live tool."
      }
      const lines = clean.map((h) => {
        const text = h.text.length > HIT_MAX ? h.text.slice(0, HIT_MAX - 1) + "…" : h.text
        return `- [${h.source ?? "memory"}${age(h.ts)}] ${text}`
      })
      return `Recalled ${clean.length} memor${clean.length === 1 ? "y" : "ies"} (may be stale — live data still needs a tool):\n${lines.join("\n")}`
    },
  }
}

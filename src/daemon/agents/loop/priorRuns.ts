// src/daemon/agents/loop/priorRuns.ts
// R8 — close the AWM learning loop's REUSE half. The induction half already feeds
// finished sub-agent trajectories to the AwmWorker; this retrieves the most similar
// PAST SUCCESSFUL runs for a new goal (token-overlap similarity over the raw
// subagents.jsonl) and renders them as a short system-prompt hint, so a recurring
// task reuses the approach that worked instead of rediscovering it. Pure + testable;
// no embeddings (cheap, deterministic, good enough for goal-string matching).

export interface PriorRun {
  goal: string
  finalText?: string
  toolCalls?: Array<{ name: string }>
  stopped?: string
}

const STOP = new Set([
  "the", "a", "an", "to", "of", "for", "and", "or", "my", "your", "in", "on", "with",
  "is", "are", "do", "that", "this", "it", "me", "i", "please", "kairos", "background", "task",
])

function tokens(s: string): Set<string> {
  return new Set(
    String(s ?? "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)),
  )
}

/** Cosine-ish token overlap in [0,1]. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let n = 0
  for (const t of a) if (b.has(t)) n++
  return n / Math.sqrt(a.size * b.size)
}

/** Parse a subagents.jsonl blob into PriorRun records (skips malformed lines). */
export function parsePriorRuns(jsonl: string | null | undefined): PriorRun[] {
  if (!jsonl) return []
  const out: PriorRun[] = []
  for (const line of jsonl.split("\n")) {
    const t = line.trim()
    if (!t) continue
    try { const o = JSON.parse(t); if (o && typeof o.goal === "string") out.push(o) } catch { /* skip */ }
  }
  return out
}

/** Render the top-K similar SUCCESSFUL prior runs as a system-prompt hint ("" = none). */
export function buildPriorRunsHint(
  goal: string,
  runs: PriorRun[],
  opts: { max?: number; minScore?: number } = {},
): string {
  const max = opts.max ?? 2
  const minScore = opts.minScore ?? 0.3
  const g = tokens(goal)
  if (!g.size) return ""
  const scored = runs
    .filter((r) => (r.stopped === "final" || r.stopped === "max_turns") && String(r.finalText ?? "").trim())
    .filter((r) => r.goal.trim().toLowerCase() !== goal.trim().toLowerCase()) // not the run in progress
    .map((r) => ({ r, score: similarity(g, tokens(r.goal)) }))
    .filter((x) => x.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
  if (!scored.length) return ""
  const lines = scored
    .map(({ r }) => {
      const tools = [...new Set((r.toolCalls ?? []).map((c) => c.name))].filter((n) => n !== "update_plan").slice(0, 6).join(", ")
      return `- Goal: "${r.goal.slice(0, 100)}"\n  Outcome: ${String(r.finalText).slice(0, 160)}${tools ? `\n  Tools used: ${tools}` : ""}`
    })
    .join("\n")
  return `## Similar tasks you've completed before\nYou've handled tasks like this one. Reuse the approach that worked (adapt, don't blindly copy):\n${lines}`
}

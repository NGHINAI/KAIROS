// src/daemon/agents/toolUsageTracker.ts
// Counts how often each Composio/agency tool is actually executed, so the
// conductor can keep the user's MOST-USED tools "hot" (loaded directly in the
// planner's core set, skipping the search_tools → execute_tool hop on common
// actions). Persistence is injected (a JSON file in real use, in-memory in tests).

export interface ToolUsageDeps {
  load: () => Record<string, number>
  save: (counts: Record<string, number>) => void
}

export class ToolUsageTracker {
  private counts: Record<string, number>

  constructor(private deps: ToolUsageDeps) {
    this.counts = { ...(deps.load() ?? {}) }
  }

  record(toolName: string): void {
    const name = String(toolName ?? "").trim()
    if (!name) return
    this.counts[name] = (this.counts[name] ?? 0) + 1
    try { this.deps.save({ ...this.counts }) } catch { /* persistence is best-effort */ }
  }

  /** The top-N tool names by usage count, descending. */
  topNames(n: number): string[] {
    return Object.entries(this.counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, Math.max(0, n))
      .map(([name]) => name)
  }
}

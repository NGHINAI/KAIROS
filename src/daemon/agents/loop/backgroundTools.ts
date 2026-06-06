// src/daemon/agents/loop/backgroundTools.ts
// The tools the FOREGROUND agent uses to drive + check on the background agent lane:
//   • spawn_background_task — kick off a heavy/long task in the background (the
//     model calls this when something shouldn't block the conversation).
//   • background_tasks — check on running/recent sub-agents ("how's my task going?").
//     Returns structured status; the foreground agent then says it in human words.

import type { ToolDef } from "../types"
import type { BgTask } from "./backgroundAgentManager"

export interface BackgroundToolsDeps {
  manager: {
    spawn: (goal: string, opts?: { depth?: number }) => { id: string; accepted: boolean; reason?: string }
    listAll: () => BgTask[]
  }
}

export function buildBackgroundTools(deps: BackgroundToolsDeps): ToolDef[] {
  return [
    {
      name: "spawn_background_task",
      description:
        "Start a heavy, long-running, or multi-step task in the BACKGROUND so the conversation isn't blocked. " +
        "Use for things that take a while (organize my inbox, research X, draft a report). KAIROS will report back when it's done.",
      parameters: { type: "object", properties: { goal: { type: "string", description: "The full task, self-contained." } }, required: ["goal"] },
      execute: async (a: { goal: string }) => {
        const goal = String(a?.goal ?? "").trim()
        if (!goal) return "I need a clear goal to run in the background."
        const r = deps.manager.spawn(goal)
        return r.accepted
          ? `Started in the background: ${goal}. I'll let you know when it's done — you can keep talking.`
          : `Couldn't start that in the background right now (${r.reason ?? "unavailable"}).`
      },
    },
    {
      name: "background_tasks",
      description:
        "Check on background tasks — what they're doing, progress, and results. Use when the user asks 'how's that going?', " +
        "'what is it doing?', 'is it done?', or about a task running in the background.",
      parameters: { type: "object", properties: {} },
      concurrencySafe: true,
      execute: async () => {
        const all = deps.manager.listAll()
        const tasks = all
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, 8)
          .map((t) => ({
            goal: t.goal,
            status: t.status,
            doing: t.status === "running" ? (t.lastActivity ?? "working") : undefined,
            tools_used: t.toolsUsed,
            summary: t.status === "done" ? t.summary : undefined,
            error: t.status === "failed" ? t.error : undefined,
          }))
        return tasks.length === 0
          ? { tasks: [], note: "No background tasks running or recently finished." }
          : { tasks }
      },
    },
  ]
}

// src/daemon/agents/loop/updatePlanTool.ts
// A lightweight checklist tool (Codex's update_plan). The plan lives entirely in
// the conversation history — calling this just records the current steps and
// emits them (for the UI / trajectory). On multi-step tasks it keeps a weaker
// model coherent because the plan survives across turns and compaction summaries.

import type { ToolDef } from "../types"

export type PlanStep = { step: string; status: "pending" | "in_progress" | "completed" }

export function buildUpdatePlanTool(deps: { onPlan?: (plan: PlanStep[]) => void }): ToolDef {
  return {
    name: "update_plan",
    description:
      "Track a short checklist for a multi-step task. Skip it for simple one-step requests. " +
      "Keep at most one step 'in_progress'; update the plan after finishing each step.",
    parameters: {
      type: "object",
      properties: {
        explanation: { type: "string", description: "Optional one-line note on the update" },
        plan: {
          type: "array",
          description: "The current steps and their status",
          items: {
            type: "object",
            properties: {
              step: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
            },
            required: ["step", "status"],
          },
        },
      },
      required: ["plan"],
    },
    execute: async (args: { plan?: any[] }) => {
      const raw = Array.isArray(args?.plan) ? args.plan : []
      const plan: PlanStep[] = raw.map((s: any) => ({
        step: String(s?.step ?? ""),
        status: ["pending", "in_progress", "completed"].includes(s?.status) ? s.status : "pending",
      }))
      try { deps.onPlan?.(plan) } catch { /* never break the turn on a UI hook */ }
      const doneCount = plan.filter((s) => s.status === "completed").length
      return `Plan updated (${doneCount}/${plan.length} done).`
    },
  }
}

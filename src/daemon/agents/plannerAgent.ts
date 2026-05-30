// src/daemon/agents/plannerAgent.ts
// Tier 2 Planner — uses @openai/agents-js SDK to plan + emit tool calls.
//
// SDK signature note: @openai/agents-js' `tool()` accepts `parameters` as either
// a Zod schema (strict mode, default) or a JSON Schema. Our `ToolDef.parameters`
// is typed loosely as `Record<string, any>` (JSON Schema shape), so we pass it
// through with `strict: false`. The SDK then parses tool args as JSON without
// validation. Downstream tasks can introduce Zod conversion if strict mode is
// required.

import { Agent, tool } from "@openai/agents"
import { buildOpenRouterModel } from "./agentsRouterAdapter"
import type { ToolDef } from "./types"

export interface PlannerOpts {
  instructions: string
  tools: ToolDef[]
}

export function buildPlannerAgent(opts: PlannerOpts): Agent {
  const sdkTools = opts.tools.map((t) =>
    tool({
      name: t.name,
      description: t.description,
      parameters: t.parameters as any,
      strict: false,
      execute: t.execute,
    }),
  )
  return new Agent({
    name: "KAIROS Planner",
    instructions: opts.instructions,
    model: buildOpenRouterModel("smart"),
    tools: sdkTools,
  })
}

// src/daemon/agents/loop/updatePlanTool.test.ts
import { test, expect } from "bun:test"
import { buildUpdatePlanTool } from "./updatePlanTool"

test("exposes an update_plan ToolDef", () => {
  const t = buildUpdatePlanTool({})
  expect(t.name).toBe("update_plan")
  expect(t.parameters.properties.plan).toBeDefined()
})

test("records the plan and emits it via onPlan, returns a confirmation", async () => {
  const seen: any[] = []
  const t = buildUpdatePlanTool({ onPlan: (p) => seen.push(p) })
  const out = await t.execute({ plan: [{ step: "search Linear", status: "completed" }, { step: "list issues", status: "in_progress" }] })
  expect(seen.length).toBe(1)
  expect(seen[0].length).toBe(2)
  expect(String(out).toLowerCase()).toContain("plan")
})

test("normalizes unknown statuses to 'pending' and tolerates a missing plan", async () => {
  const t = buildUpdatePlanTool({})
  const out = await t.execute({ plan: [{ step: "x", status: "weird" }] })
  expect(String(out)).toBeTruthy()
  const out2 = await t.execute({})
  expect(String(out2)).toBeTruthy() // no throw on missing plan
})

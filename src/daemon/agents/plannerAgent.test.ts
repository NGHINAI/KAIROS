import { test, expect } from "bun:test"
import { buildPlannerAgent } from "./plannerAgent"

test("buildPlannerAgent returns an Agent with name and instructions", () => {
  process.env.OPENROUTER_API_KEY = "sk-test"
  const agent = buildPlannerAgent({
    instructions: "You plan multi-step tool chains.",
    tools: [],
  })
  expect(agent.name).toBe("KAIROS Planner")
  expect((agent as any).instructions).toContain("plan multi-step")
})

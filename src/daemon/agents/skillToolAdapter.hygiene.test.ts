// Skill-tool descriptions are framed as NARROW saved procedures, never universal routers.
import { test, expect } from "bun:test"
import { skillsAsTools } from "./skillToolAdapter"

test("skill descriptions get the saved-procedure frame + don't-use-for-everything rule", () => {
  const tools = skillsAsTools(
    { activeSkills: () => [{ id: "weekly-report", name: "weekly-report", description: "Draft the weekly report from Linear." }] } as any,
    { dispatch: async () => ({}) } as any,
  )
  expect(tools[0]!.name).toBe("kairos_skill_weekly_report")
  expect(tools[0]!.description).toContain('Saved procedure "weekly-report"')
  expect(tools[0]!.description).toContain("Use ONLY when the request matches")
  expect(tools[0]!.description).toContain("search_tools/execute_tool")
})

// src/daemon/agents/skillToolAdapter.test.ts
import { test, expect } from "bun:test"
import { skillsAsTools } from "./skillToolAdapter"

test("skillsAsTools converts SkillRegistry entries into ToolDef[]", () => {
  const fakeRegistry = {
    activeSkills: () => [
      {
        id: "gmail-summary",
        name: "Gmail summary",
        description: "Summarize gmail inbox",
        parameters: { type: "object", properties: { since: { type: "string" } }, required: [] },
      } as any,
    ],
  }
  const fakeDispatcher = { dispatch: async (id: string, args: any) => ({ ok: true, ran: id, args }) }
  const tools = skillsAsTools(fakeRegistry as any, fakeDispatcher as any)
  expect(tools.length).toBe(1)
  expect(tools[0].name).toBe("kairos_skill_gmail_summary")
})

// src/daemon/agents/skillToolAdapter.ts
// Converts KAIROS crystallized skills (from SkillRegistry) into ToolDefs
// the agent can call. Tool names are prefixed `kairos_skill_<id>` to avoid
// collision with Composio toolkit tools.

import type { ToolDef } from "./types"

interface SkillRegistryLike {
  activeSkills(): Array<{
    id: string
    name?: string
    description?: string
    parameters?: Record<string, any>
  }>
}

interface SkillDispatcherLike {
  dispatch(skillId: string, args: any): Promise<any>
}

export function skillsAsTools(registry: SkillRegistryLike, dispatcher: SkillDispatcherLike): ToolDef[] {
  const skills = registry.activeSkills()
  return skills.map((s) => {
    const safeName = s.id.replace(/[^a-zA-Z0-9_]/g, "_")
    return {
      name: `kairos_skill_${safeName}`,
      description: s.description ?? `KAIROS crystallized skill: ${s.name ?? s.id}`,
      parameters: s.parameters ?? { type: "object", properties: {}, required: [] },
      execute: async (args: any) => dispatcher.dispatch(s.id, args),
    }
  })
}

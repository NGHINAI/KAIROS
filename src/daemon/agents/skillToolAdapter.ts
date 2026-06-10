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
      // The planner picks tools BY DESCRIPTION, so a skill's self-description must never be
      // able to outbid real app tools (a crystallized meta-skill once claimed to "route any
      // request" and hijacked ordinary calendar turns — 2026-06-10). Frame every skill as the
      // narrow saved procedure it is, with an explicit don't-use-for-everything rule.
      description:
        `Saved procedure "${s.name ?? s.id}": ${s.description ?? "a multi-step routine KAIROS learned"} ` +
        `(Use ONLY when the request matches this exact procedure. For ordinary app actions — email, calendar, ` +
        `messages, search — use the app's own tools via search_tools/execute_tool instead.)`,
      parameters: s.parameters ?? { type: "object", properties: {}, required: [] },
      execute: async (args: any) => dispatcher.dispatch(s.id, args),
    }
  })
}

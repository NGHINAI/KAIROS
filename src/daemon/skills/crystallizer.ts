// src/daemon/skills/crystallizer.ts
// LLM-composes a candidate SkillFile from a cluster of successful trajectories.
// Uses task_type 'skill_crystallize' at medium tier.

import type { ModelRouter } from '../llm/router'
import type { SkillCandidate, SkillFile } from './types'

const SYSTEM_PROMPT = `You are crystallizing a reusable skill from a cluster of successful agent trajectories. Each trajectory shows the agent completing a similar task using a sequence of tool calls.

Your job: produce a JSON object representing a SKILL.md file that captures the reusable workflow.

The JSON must match this exact shape:
{
  "name": "kebab-case-slug",
  "description": "Short string stating WHAT this skill does AND WHEN to use it. 1-1024 chars.",
  "body": "# Markdown body\\n\\nStep-by-step instructions, parameterized over arguments.",
  "metadata": {
    "kairos:autonomy_tier": "GREEN" | "YELLOW" | "ORANGE" | "RED",
    "kairos:auto_crystallized": "true",
    "kairos:source_trajectories": "<number>"
  }
}

Hard constraints on the output:
- "name" must be 1-64 chars, lowercase alphanumeric + hyphens only (regex: ^[a-z0-9][a-z0-9-]*$)
- "description" must be 1-1024 chars and explicitly state WHAT + WHEN
- "body" should be step-by-step instructions in markdown, generalized over the specific arg values in the trajectories
- "kairos:autonomy_tier" — assign based on the tools used in the trajectories:
  * GREEN: read-only operations (search, list, get_*)
  * YELLOW: low-risk write operations (send_message, create_issue, add_note)
  * ORANGE: medium-risk writes (modify_settings, schedule_meeting, mass_actions)
  * RED: destructive operations (delete_*, drop_*, payment_*)
- "kairos:auto_crystallized" must be the string "true"
- "kairos:source_trajectories" must be the count of trajectories in the input cluster (as string)

Output strict JSON only — no commentary, no markdown code fences.`

export type CrystallizerOptions = {
  router: ModelRouter
}

// A META/ROUTER "skill" — one that claims to handle ANY request or route to "the appropriate
// tool/service" — is not a procedure, it's a description-level trap: the planner picks tools
// by description, so a universal-sounding skill outbids real app tools and hijacks ordinary
// turns (2026-06-10: auto-crystallized "agent-turn-smart" hijacked a calendar question).
// Skills must be NARROW, concrete procedures; meta-skills are rejected at the source.
const META_SKILL_RE =
  /\b(rout(e|es|ing)|dispatch(es|ing)?|orchestrat\w*|delegat\w*|appropriate (tool|service|integration)|any (request|task|integrated service)|without specifying which|select(s|ing)? the (right|correct) tool|agent turn|smart turn|general[- ]purpose (agent|assistant|handler))\b/i

export function isMetaSkill(name: string, description: string): boolean {
  return META_SKILL_RE.test(`${name} ${description}`)
}

export class SkillCrystallizer {
  constructor(private opts: CrystallizerOptions) {}

  async crystallize(candidate: SkillCandidate): Promise<SkillFile> {
    if (candidate.trajectories.length === 0) {
      throw new Error('SkillCrystallizer: candidate has zero trajectories')
    }

    const userPrompt = `Cluster of ${candidate.trajectories.length} successful trajectories with shared signature:

Representative signature:
- intent_id: ${candidate.representative_signature.intent_id}
- common_args: ${JSON.stringify(candidate.representative_signature.common_args)}
- avg_tool_calls: ${candidate.representative_signature.avg_tool_calls}
- success_rate: ${candidate.representative_signature.success_rate}

Trajectories (first 3 shown, rest similar):
${candidate.trajectories.slice(0, 3).map((t, i) => `
[${i + 1}] ${JSON.stringify(t).slice(0, 500)}`).join('\n')}

Crystallize this into a SKILL.md JSON object.`

    const result = await this.opts.router.complete({
      task_type: 'skill_crystallize' as any,
      system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long', source: 'persona' }],
      prompt: userPrompt,
      structured: true,
      max_output_tokens: 2000,
      latency_target: 'standard',
    })

    const parsed = result.parsed as any
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('SkillCrystallizer: LLM did not return parseable JSON')
    }
    if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string' || typeof parsed.body !== 'string') {
      throw new Error('SkillCrystallizer: missing required fields in LLM output (name/description/body)')
    }
    if (isMetaSkill(parsed.name, parsed.description)) {
      throw new Error(`SkillCrystallizer: rejected meta/router skill "${parsed.name}" — skills must be narrow concrete procedures, never universal routers`)
    }

    // Enforce KAIROS metadata extensions
    const metadata: Record<string, string> = { ...(parsed.metadata ?? {}) }
    metadata['kairos:auto_crystallized'] = 'true'
    metadata['kairos:source_trajectories'] = String(candidate.trajectories.length)
    if (!metadata['kairos:autonomy_tier']) {
      metadata['kairos:autonomy_tier'] = 'YELLOW'   // safe default if LLM omitted
    }

    const skill: SkillFile = {
      name: parsed.name,
      description: parsed.description,
      slug: parsed.name,
      body: parsed.body,
      metadata,
      dir_path: '',   // SkillWriter will set this
      has_scripts: false,
      has_references: false,
    }
    return skill
  }
}

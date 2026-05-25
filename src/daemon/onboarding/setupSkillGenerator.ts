// src/daemon/onboarding/setupSkillGenerator.ts
import type { ModelRouter } from '../llm/router'
import type { SetupSkill, SetupStep } from './types'

const VALID_STEP_TYPES = new Set<SetupStep['type']>([
  'speak', 'open_url', 'wait_for_clipboard', 'wait_for_oauth_callback',
  'store_keychain', 'install_mcp_server', 'configure_mcp_server',
  'smoke_test_tool', 'await_user_confirm', 'speak_on_success', 'speak_on_failure',
])

const SYSTEM_PROMPT = `You are KAIROS's onboarding skill generator. Given a service name (e.g. "github", "slack", "notion"), produce a JSON SetupSkill that walks the user through obtaining a credential, installing the appropriate MCP server, configuring, smoke-testing, and confirming.

Use ONLY these step types: speak | open_url | wait_for_clipboard | wait_for_oauth_callback | store_keychain | install_mcp_server | configure_mcp_server | smoke_test_tool | await_user_confirm | speak_on_success | speak_on_failure

Output strict JSON matching:
{
  "service_name": "github", "service_display_name": "GitHub",
  "auth_type": "pat" | "oauth" | "none", "estimated_minutes": 2,
  "steps": [ ... ]
}

Hard constraints:
- URLs must use https (or http://localhost for OAuth callbacks)
- speak_on_success and speak_on_failure are REQUIRED as final two steps
- smoke_test_tool step is REQUIRED before declaring success
- Package names must be valid (no shell injection patterns)
- estimated_minutes must be conservative (3-5 min typical)

Output ONLY the JSON. No commentary.`

export class SetupSkillGenerator {
  constructor(private router: ModelRouter) {}

  async generate(serviceName: string): Promise<SetupSkill> {
    const result = await this.router.complete({
      task_type: 'skill_generate',
      system: SYSTEM_PROMPT,
      prompt: `Service to set up: ${serviceName}\n\nProduce the SetupSkill JSON.`,
      structured: true,
      max_output_tokens: 2000,
      latency_target: 'standard',
    })

    const parsed = result.parsed as SetupSkill | undefined
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`SetupSkillGenerator: LLM did not return parseable JSON`)
    }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(`SetupSkillGenerator: skill has no steps`)
    }
    for (const step of parsed.steps) {
      if (!VALID_STEP_TYPES.has(step.type)) {
        throw new Error(`SetupSkillGenerator: unknown step type: ${(step as any).type}`)
      }
    }
    return parsed
  }
}

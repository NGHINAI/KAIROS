// src/daemon/onboarding/setupSkillGenerator.ts
import type { ModelRouter } from '../llm/router'
import type { SetupSkill, SetupStep } from './types'
import type { ServiceResolver, ResolvedService } from './serviceResolver'

const VALID_STEP_TYPES = new Set<SetupStep['type']>([
  'speak', 'open_url', 'wait_for_clipboard', 'wait_for_oauth_callback',
  'store_keychain', 'install_mcp_server', 'configure_mcp_server',
  'smoke_test_tool', 'await_user_confirm', 'speak_on_success', 'speak_on_failure',
])

const SYSTEM_PROMPT = `You are KAIROS's onboarding skill generator. Given a service name (e.g. "github", "slack", "notion"), produce a JSON SetupSkill that walks the user through obtaining a credential, installing the appropriate MCP server, configuring, smoke-testing, and confirming.

CRITICAL: You will be given a list of REAL package names found by pre-flight lookup. You MUST use one of those exact names in the install_mcp_server step. Do NOT invent or guess package names. If no candidates are provided, respond with the error JSON described in the user prompt.

Use ONLY these step types: speak | open_url | wait_for_clipboard | wait_for_oauth_callback | store_keychain | install_mcp_server | configure_mcp_server | smoke_test_tool | await_user_confirm | speak_on_success | speak_on_failure

Output strict JSON matching:
{
  "service_name": "github", "service_display_name": "GitHub",
  "auth_type": "pat" | "oauth" | "none", "estimated_minutes": 2,
  "steps": [ ... ]
}

Step type reference — use these EXACT field names:

{ "type": "speak", "text": "string to say to user" }
{ "type": "open_url", "url": "https://..." }
{ "type": "wait_for_clipboard", "pattern": "^regex$", "timeout_sec": 300, "description": "what the user is copying" }
{ "type": "wait_for_oauth_callback", "callback_path": "/oauth-cb", "expected_param": "code", "timeout_sec": 300 }
{ "type": "store_keychain", "service": "com.kairos.SERVICENAME", "account": "token", "source": "clipboard" }
   // source must be one of: "clipboard" | "oauth" | "literal"
   // if source="literal", also include "literal_value": "..."
{ "type": "install_mcp_server", "via": "npm", "package": "@scope/package-name" }
   // via must be one of: "npm" | "smithery"
   // optional: "smoke_args": ["--version"]
{ "type": "configure_mcp_server", "server_config": {
    "id": "github",
    "enabled": true,
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "from-keychain" },
    "auth_keychain": { "service": "com.kairos.github", "account": "token", "env_var": "GITHUB_PERSONAL_ACCESS_TOKEN" },
    "tier_policy": { "default": "YELLOW" }
  } }
{ "type": "smoke_test_tool", "qualified_id": "github::list_repositories", "args": { "username": "me" } }
   // qualified_id MUST be in the format "<server-id>::<tool-name>"
   // server-id must match server_config.id from the configure step
   // do NOT use server_name + tool_name as separate fields
{ "type": "await_user_confirm", "prompt": "Connect this account to KAIROS?", "default_choice": "yes" }
{ "type": "speak_on_success", "text": "Connected. Try asking me to list your repos." }
{ "type": "speak_on_failure", "text": "Setup failed. Re-running often fixes it." }

CRITICAL field-name rules:
- speak steps use "text" NOT "message"
- install_mcp_server uses "via" NOT "runtime", "package" NOT "command"
- smoke_test_tool uses ONE field "qualified_id" formatted "server::tool", NOT separate server_name/tool_name fields
- Every step's "type" must be from the list above; no other types allowed
- Do NOT invent additional step types beyond the 11 listed above
- Do NOT wrap fields in extra objects or rename them

Hard constraints:
- URLs must use https (or http://localhost for OAuth callbacks)
- speak_on_success and speak_on_failure are REQUIRED as final two steps
- smoke_test_tool step is REQUIRED before declaring success
- Package names must be valid (no shell injection patterns)
- estimated_minutes must be conservative (3-5 min typical)

Output ONLY the JSON. No commentary.`

function validateStep(step: any, i: number): void {
  const type: string = step.type
  const fail = (reason: string): never => {
    throw new Error(`SetupSkillGenerator: step ${i} (${type}) field validation failed: ${reason}`)
  }

  switch (type) {
    case 'speak':
    case 'speak_on_success':
    case 'speak_on_failure':
      if (typeof step.text !== 'string' || step.text.trim() === '') {
        fail('"text" must be a non-empty string (not "message" or any other field name)')
      }
      break

    case 'open_url':
      if (typeof step.url !== 'string' || step.url.trim() === '') {
        fail('"url" must be a non-empty string')
      }
      if (!step.url.startsWith('http://') && !step.url.startsWith('https://')) {
        fail('"url" must start with http:// or https://')
      }
      break

    case 'wait_for_clipboard':
      if (typeof step.pattern !== 'string' || step.pattern.trim() === '') {
        fail('"pattern" must be a non-empty string')
      }
      try {
        new RegExp(step.pattern)
      } catch {
        fail(`"pattern" is not a valid regex: ${step.pattern}`)
      }
      if (typeof step.description !== 'string' || step.description.trim() === '') {
        fail('"description" must be a non-empty string')
      }
      break

    case 'wait_for_oauth_callback':
      if (typeof step.callback_path !== 'string' || !step.callback_path.startsWith('/')) {
        fail('"callback_path" must be a string starting with "/"')
      }
      if (typeof step.expected_param !== 'string' || step.expected_param.trim() === '') {
        fail('"expected_param" must be a non-empty string')
      }
      break

    case 'store_keychain':
      if (typeof step.service !== 'string' || step.service.trim() === '') {
        fail('"service" must be a non-empty string')
      }
      if (typeof step.account !== 'string' || step.account.trim() === '') {
        fail('"account" must be a non-empty string')
      }
      if (!['clipboard', 'oauth', 'literal'].includes(step.source)) {
        fail('"source" must be one of: "clipboard" | "oauth" | "literal"')
      }
      if (step.source === 'literal' && (typeof step.literal_value !== 'string' || step.literal_value.trim() === '')) {
        fail('"literal_value" must be a non-empty string when source="literal"')
      }
      break

    case 'install_mcp_server':
      if (!['npm', 'smithery'].includes(step.via)) {
        fail('"via" must be one of: "npm" | "smithery" (not "runtime", "npx", or any other value)')
      }
      if (typeof step.package !== 'string' || step.package.trim() === '') {
        fail('"package" must be a non-empty string (not "command" or any other field name)')
      }
      break

    case 'configure_mcp_server':
      if (!step.server_config || typeof step.server_config !== 'object') {
        fail('"server_config" must be an object')
      }
      if (typeof step.server_config.id !== 'string' || step.server_config.id.trim() === '') {
        fail('"server_config.id" must be a non-empty string')
      }
      break

    case 'smoke_test_tool':
      if (typeof step.qualified_id !== 'string' || !/^[a-z0-9_-]+::[a-z0-9_-]+$/i.test(step.qualified_id)) {
        fail('"qualified_id" must match format "<server-id>::<tool-name>" (do NOT use separate server_name/tool_name fields)')
      }
      break

    case 'await_user_confirm':
      if (typeof step.prompt !== 'string' || step.prompt.trim() === '') {
        fail('"prompt" must be a non-empty string')
      }
      break
  }
}

function formatGroundingBlock(resolved: ResolvedService): string {
  if (resolved.candidates.length === 0) {
    return `\nNo real packages were found for this service by pre-flight lookup.\n\nIf this list is empty, respond with a JSON error:\n{ "error": "no MCP package found for ${resolved.service_name}", "suggestion": "<helpful hint>" }\n`
  }

  const lines = resolved.candidates.map(c =>
    `[${c.source}] ${c.package_name ?? '(non-npm)'}  (confidence ${c.confidence.toFixed(2)})`
  )

  return `\nReal packages found for this service (use ONE of these EXACT package names — do not invent others):\n\n${lines.join('\n')}\n\nPrefer the official_mcp_catalog entry when present. If multiple candidates are equally suitable, pick the most-downloaded one. Do NOT generate a SetupSkill with any package name not in this list.\n\nIf this list is empty, respond with a JSON error:\n{ "error": "no MCP package found for ${resolved.service_name}", "suggestion": "<helpful hint>" }\n`
}

export class SetupSkillGenerator {
  constructor(
    private router: ModelRouter,
    private resolver?: ServiceResolver,    // optional for backward compat
  ) {}

  async generate(serviceName: string): Promise<SetupSkill> {
    // 1. Pre-flight grounding (if resolver available)
    let groundingBlock = ''
    let zeroCandidates = false
    if (this.resolver) {
      const resolved = await this.resolver.resolve(serviceName)
      groundingBlock = formatGroundingBlock(resolved)
      zeroCandidates = resolved.candidates.length === 0
    }

    // 2. LLM call with grounding injected
    const result = await this.router.complete({
      task_type: 'skill_generate',
      system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
      prompt: `Service to set up: ${serviceName}${groundingBlock}\n\nProduce the SetupSkill JSON.`,
      structured: true,
      max_output_tokens: 2000,
      latency_target: 'standard',
    })

    // 3. Check for error JSON (zero-candidates path)
    const parsed = result.parsed as any
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const suggestion = (parsed as any).suggestion ?? 'no suggestion'
      throw new Error(`SetupSkillGenerator: no candidates for ${serviceName} — resolver suggestion: ${suggestion}`)
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`SetupSkillGenerator: LLM did not return parseable JSON`)
    }
    if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) {
      throw new Error(`SetupSkillGenerator: skill has no steps`)
    }
    for (let i = 0; i < parsed.steps.length; i++) {
      const step = parsed.steps[i] as any
      if (!VALID_STEP_TYPES.has(step.type)) {
        throw new Error(`SetupSkillGenerator: unknown step type: ${step.type}`)
      }
      validateStep(step, i)
    }
    return parsed as SetupSkill
  }
}

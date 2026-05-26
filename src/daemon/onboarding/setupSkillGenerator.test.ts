// src/daemon/onboarding/setupSkillGenerator.test.ts
import { describe, it, expect } from 'bun:test'
import { SetupSkillGenerator } from './setupSkillGenerator'
import type { ModelRouter } from '../llm/router'
import type { ServiceResolver } from './serviceResolver'

function fakeRouter(skill: any): ModelRouter {
  return {
    complete: async () => ({
      text: JSON.stringify(skill), parsed: skill,
      provider: 'anthropic_cli', model: 'opus', cost_cents: 0, latency_ms: 100,
      fallback_count: 0, input_tokens: 100, output_tokens: 500,
    }),
  } as unknown as ModelRouter
}

describe('SetupSkillGenerator', () => {
  it('generates a SetupSkill for a service name', async () => {
    const router = fakeRouter({
      service_name: 'github', service_display_name: 'GitHub',
      auth_type: 'pat', estimated_minutes: 2,
      steps: [
        { type: 'speak', text: 'Opening GitHub tokens page.' },
        { type: 'open_url', url: 'https://github.com/settings/tokens/new' },
      ],
    })
    const gen = new SetupSkillGenerator(router)
    const skill = await gen.generate('github')
    expect(skill.service_name).toBe('github')
    expect(skill.steps.length).toBe(2)
  })

  it('rejects skill with no steps', async () => {
    const router = fakeRouter({ service_name: 'x', service_display_name: 'X', auth_type: 'none', steps: [], estimated_minutes: 0 })
    const gen = new SetupSkillGenerator(router)
    await expect(gen.generate('x')).rejects.toThrow(/no steps/i)
  })

  it('rejects on LLM error', async () => {
    const router = { complete: async () => { throw new Error('LLM down') } } as unknown as ModelRouter
    const gen = new SetupSkillGenerator(router)
    await expect(gen.generate('github')).rejects.toThrow(/LLM down|generate/i)
  })

  it('validates that step types are recognized', async () => {
    const router = fakeRouter({
      service_name: 'x', service_display_name: 'X', auth_type: 'none', estimated_minutes: 1,
      steps: [{ type: 'rm_rf', target: '/' } as any],
    })
    const gen = new SetupSkillGenerator(router)
    await expect(gen.generate('x')).rejects.toThrow(/unknown step type/i)
  })

  it('rejects steps with wrong field names (e.g. message instead of text)', async () => {
    const router = fakeRouter({
      service_name: 'x', service_display_name: 'X', auth_type: 'none', estimated_minutes: 1,
      steps: [{ type: 'speak', message: 'wrong field name' } as any],
    })
    const gen = new SetupSkillGenerator(router)
    await expect(gen.generate('x')).rejects.toThrow(/text|field validation/i)
  })

  it('rejects smoke_test_tool with split server_name + tool_name', async () => {
    const router = fakeRouter({
      service_name: 'x', service_display_name: 'X', auth_type: 'none', estimated_minutes: 1,
      steps: [{ type: 'smoke_test_tool', server_name: 'foo', tool_name: 'bar' } as any],
    })
    const gen = new SetupSkillGenerator(router)
    await expect(gen.generate('x')).rejects.toThrow(/qualified_id|field validation/i)
  })

  it('rejects install_mcp_server with wrong via value', async () => {
    const router = fakeRouter({
      service_name: 'x', service_display_name: 'X', auth_type: 'none', estimated_minutes: 1,
      steps: [{ type: 'install_mcp_server', via: 'pip', package: 'foo' } as any],
    })
    const gen = new SetupSkillGenerator(router)
    await expect(gen.generate('x')).rejects.toThrow(/via|field validation/i)
  })

  it('passes candidates from resolver into the LLM prompt', async () => {
    const validSkill = {
      service_name: 'x', service_display_name: 'X',
      auth_type: 'none', estimated_minutes: 1,
      steps: [
        { type: 'speak', text: 'Setting up x.' },
        { type: 'install_mcp_server', via: 'npm', package: '@real/pkg' },
        { type: 'configure_mcp_server', server_config: { id: 'x', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@real/pkg'], tier_policy: { default: 'YELLOW' } } },
        { type: 'smoke_test_tool', qualified_id: 'x::some_tool' },
        { type: 'speak_on_success', text: 'Done.' },
        { type: 'speak_on_failure', text: 'Failed.' },
      ],
    }
    const captured: { prompt?: string } = {}
    const router = {
      complete: async (req: any) => {
        captured.prompt = req.prompt
        return { text: JSON.stringify(validSkill), parsed: validSkill, provider: 'anthropic_cli', model: 'opus', cost_cents: 0, latency_ms: 100, fallback_count: 0, input_tokens: 100, output_tokens: 500 } as any
      },
    } as unknown as ModelRouter
    const resolver = {
      resolve: async () => ({
        service_name: 'x',
        candidates: [
          { source: 'npm', package_name: '@real/pkg', confidence: 0.9, install_type: 'npm', description: 'd' },
        ],
        resolved_at: 0,
      }),
    } as unknown as ServiceResolver
    const gen = new SetupSkillGenerator(router, resolver)
    await gen.generate('x')
    expect(captured.prompt).toContain('@real/pkg')
    expect(captured.prompt).toContain('use ONE of these EXACT package names')
  })

  it('throws clear error when resolver finds zero candidates AND LLM returns error JSON', async () => {
    const router = {
      complete: async () => ({
        text: '{"error":"no MCP package found for nonexistent","suggestion":"try a different name"}',
        parsed: { error: 'no MCP package found for nonexistent', suggestion: 'try a different name' },
        provider: 'anthropic_cli', model: 'opus', cost_cents: 0, latency_ms: 100,
        fallback_count: 0, input_tokens: 100, output_tokens: 50,
      } as any),
    } as unknown as ModelRouter
    const resolver = {
      resolve: async () => ({
        service_name: 'nonexistent',
        candidates: [],
        resolved_at: 0,
        notes: 'no MCP server found',
      }),
    } as unknown as ServiceResolver
    const gen = new SetupSkillGenerator(router, resolver)
    await expect(gen.generate('nonexistent')).rejects.toThrow(/no candidates|no MCP package/i)
  })
})

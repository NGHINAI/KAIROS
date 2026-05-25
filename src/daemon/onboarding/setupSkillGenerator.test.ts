// src/daemon/onboarding/setupSkillGenerator.test.ts
import { describe, it, expect } from 'bun:test'
import { SetupSkillGenerator } from './setupSkillGenerator'
import type { ModelRouter } from '../llm/router'

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
})

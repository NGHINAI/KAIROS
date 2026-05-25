// src/daemon/llm/policy.test.ts
import { describe, it, expect } from 'bun:test'
import { tierForTask, defaultCandidates } from './policy'

describe('policy', () => {
  it('maps task types to tiers', () => {
    expect(tierForTask('narrative')).toBe('ultra_cheap')
    expect(tierForTask('trigger_eval')).toBe('ultra_cheap')
    expect(tierForTask('action_compose')).toBe('mid')
    expect(tierForTask('skill_generate')).toBe('heavy')
    expect(tierForTask('source_patch')).toBe('heavy')
    expect(tierForTask('dream')).toBe('mid')
    expect(tierForTask('classify')).toBe('ultra_cheap')
  })

  it('returns ordered candidate list cheapest-first for narrative', () => {
    const cands = defaultCandidates('narrative')
    expect(cands.length).toBeGreaterThan(0)
    expect(cands[0]?.provider).toBe('gemini')      // Gemini Flash Lite is cheapest
    expect(cands.some(c => c.provider === 'anthropic_cli')).toBe(true)
  })

  it('returns heavy-tier candidates for source_patch', () => {
    const cands = defaultCandidates('source_patch')
    expect(cands[0]?.model).toMatch(/sonnet|opus|gpt-5|pro/i)
  })
})

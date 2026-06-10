import { describe, it, expect } from 'bun:test'
import { SkillCrystallizer } from './crystallizer'
import type { SkillCandidate } from './types'

function fakeRouter(out: any) {
  return {
    complete: async (req: any) => ({
      text: JSON.stringify(out),
      parsed: out,
      provider: 'fake', model: 'fake', cost_cents: 0, latency_ms: 100,
      fallback_count: 0, input_tokens: 100, output_tokens: 200,
      _taskType: req.task_type,
    }),
  }
}

function makeCandidate(occurrences: number = 5): SkillCandidate {
  return {
    cluster_id: 'cluster_abc',
    trajectories: Array(occurrences).fill(0).map((_, i) => ({
      ts: Date.now() - i * 86400_000,
      task_goal: 'send a Slack reminder',
      intent_id: 'slack_send_message',
      args_summary: 'channel=C1234 text=reminder',
      steps: [{ action: 'slack_send', result_summary: 'ok' }],
      outcome: 'success',
      duration_ms: 1200,
    })),
    representative_signature: {
      intent_id: 'slack_send_message',
      common_args: { channel: 'C1234' },
      avg_tool_calls: 5,
      success_rate: 1.0,
    },
    occurrences,
    first_seen_at: Date.now() - 7 * 86400_000,
    last_seen_at: Date.now(),
  }
}

describe('SkillCrystallizer', () => {
  it('composes a valid SkillFile from a cluster', async () => {
    const router = fakeRouter({
      name: 'slack-reminder',
      description: 'Send a Slack reminder to a channel when the user wants a status nudge.',
      body: '# Steps\n\n1. Call slack_send_message with channel and text.\n',
      metadata: { 'kairos:autonomy_tier': 'YELLOW' },
    })
    const crystallizer = new SkillCrystallizer({ router: router as any })
    const skill = await crystallizer.crystallize(makeCandidate(5))
    expect(skill.name).toBe('slack-reminder')
    expect(skill.slug).toBe('slack-reminder')
    expect(skill.description).toContain('Send a Slack reminder')
    expect(skill.body).toContain('slack_send_message')
  })

  it('rejects empty cluster', async () => {
    const router = fakeRouter({})
    const crystallizer = new SkillCrystallizer({ router: router as any })
    const empty = { ...makeCandidate(1), trajectories: [] }
    await expect(crystallizer.crystallize(empty)).rejects.toThrow(/zero trajectories/)
  })

  it('uses task_type "skill_crystallize"', async () => {
    let captured = ''
    const router = {
      complete: async (req: any) => {
        captured = req.task_type
        return {
          text: '{}',
          parsed: { name: 'x', description: 'a test skill description', body: 'body', metadata: {} },
          provider: 'fake', model: 'fake', cost_cents: 0, latency_ms: 0,
          fallback_count: 0, input_tokens: 0, output_tokens: 0,
        } as any
      },
    }
    const crystallizer = new SkillCrystallizer({ router: router as any })
    await crystallizer.crystallize(makeCandidate(3))
    expect(captured).toBe('skill_crystallize')
  })

  it('always sets kairos:auto_crystallized + kairos:source_trajectories', async () => {
    const router = fakeRouter({
      name: 'demo',
      description: 'something',
      body: 'body',
      metadata: {},   // LLM omits the kairos: fields
    })
    const crystallizer = new SkillCrystallizer({ router: router as any })
    const skill = await crystallizer.crystallize(makeCandidate(7))
    expect(skill.metadata?.['kairos:auto_crystallized']).toBe('true')
    expect(skill.metadata?.['kairos:source_trajectories']).toBe('7')
  })

  it('defaults autonomy_tier to YELLOW if LLM omits it', async () => {
    const router = fakeRouter({
      name: 'demo',
      description: 'something',
      body: 'body',
      metadata: {},
    })
    const crystallizer = new SkillCrystallizer({ router: router as any })
    const skill = await crystallizer.crystallize(makeCandidate(3))
    expect(skill.metadata?.['kairos:autonomy_tier']).toBe('YELLOW')
  })
})

import { isMetaSkill } from './crystallizer'
import { test as btest, expect as bexpect } from 'bun:test'

btest('isMetaSkill rejects router/meta skills, keeps narrow procedures', () => {
  bexpect(isMetaSkill('agent-turn-smart', 'Routes user requests to the appropriate connected tool or service')).toBe(true)
  bexpect(isMetaSkill('universal-handler', 'Handles any request without specifying which tool to use')).toBe(true)
  bexpect(isMetaSkill('task-dispatcher', 'Dispatches tasks to sub-agents')).toBe(true)
  bexpect(isMetaSkill('weekly-report', 'Draft the weekly report by pulling Linear issues and summarizing them')).toBe(false)
  bexpect(isMetaSkill('inbox-cleanup', 'Archive promotional emails older than 30 days in Gmail')).toBe(false)
})

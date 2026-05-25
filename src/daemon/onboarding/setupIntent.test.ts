// src/daemon/onboarding/setupIntent.test.ts
import { describe, it, expect } from 'bun:test'
import { createSetupIntent } from './setupIntent'

function fakes() {
  return {
    generator: {
      generate: async (name: string) => {
        if (name === 'unknown-service-xyz') throw new Error('cannot generate skill for unknown-service-xyz')
        return {
          service_name: name, service_display_name: name, auth_type: 'none' as const,
          estimated_minutes: 1,
          steps: [{ type: 'speak' as const, text: 'fake' }, { type: 'speak_on_success' as const, text: 'ok' }, { type: 'speak_on_failure' as const, text: 'err' }],
        }
      },
    },
    runtime: {
      run: async (skill: any) => ({
        flow_id: 'f1', service_name: skill.service_name,
        status: 'success' as const, duration_ms: 100,
        steps_completed: 3, steps_total: 3,
      }),
    },
  }
}

describe('setupIntent', () => {
  it('has expected metadata (id=setup_for, tier=GREEN)', () => {
    const { generator, runtime } = fakes()
    const intent = createSetupIntent({ generator: generator as any, runtime: runtime as any })
    expect(intent.id).toBe('setup_for')
    expect(intent.tier).toBe('GREEN')
  })

  it('runs the full pipeline on success', async () => {
    const { generator, runtime } = fakes()
    const intent = createSetupIntent({ generator: generator as any, runtime: runtime as any })
    const result = await intent.handler({ service_name: 'github' })
    expect(result.status).toBe('success')
    expect(result.service_name).toBe('github')
  })

  it('throws when service_name is missing', async () => {
    const { generator, runtime } = fakes()
    const intent = createSetupIntent({ generator: generator as any, runtime: runtime as any })
    await expect(intent.handler({} as any)).rejects.toThrow(/service_name/i)
  })

  it('surfaces generator errors (unknown service)', async () => {
    const { generator, runtime } = fakes()
    const intent = createSetupIntent({ generator: generator as any, runtime: runtime as any })
    await expect(intent.handler({ service_name: 'unknown-service-xyz' })).rejects.toThrow(/unknown-service-xyz/)
  })
})

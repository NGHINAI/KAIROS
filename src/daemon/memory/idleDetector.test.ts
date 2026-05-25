// src/daemon/memory/idleDetector.test.ts
import { describe, it, expect } from 'bun:test'
import { IdleDetector } from './idleDetector'

describe('IdleDetector', () => {
  it('reports a numeric idle time in ms', async () => {
    const det = new IdleDetector()
    const ms = await det.idleMs()
    expect(typeof ms).toBe('number')
    expect(ms).toBeGreaterThanOrEqual(0)
  })

  it('reports whether on AC power', async () => {
    const det = new IdleDetector()
    const onAC = await det.onACPower()
    expect(typeof onAC).toBe('boolean')
  })

  it('shouldDream returns true only when both conditions met', async () => {
    const det = new IdleDetector({
      idleThresholdMs: 100,
      probe: async () => ({ idleMs: 200, onAC: true }),
    })
    expect(await det.shouldDream()).toBe(true)

    const det2 = new IdleDetector({
      idleThresholdMs: 100,
      probe: async () => ({ idleMs: 50, onAC: true }),
    })
    expect(await det2.shouldDream()).toBe(false)

    const det3 = new IdleDetector({
      idleThresholdMs: 100,
      probe: async () => ({ idleMs: 200, onAC: false }),
    })
    expect(await det3.shouldDream()).toBe(false)
  })
})

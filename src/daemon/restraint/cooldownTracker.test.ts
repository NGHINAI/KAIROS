// src/daemon/restraint/cooldownTracker.test.ts
import { describe, it, expect } from 'bun:test'
import { CooldownTracker } from './cooldownTracker'

describe('CooldownTracker', () => {
  it('allows first fire of a trigger', () => {
    const t = new CooldownTracker(60_000)
    expect(t.canFire('trig-a')).toBe(true)
  })

  it('blocks second fire within cooldown', () => {
    const t = new CooldownTracker(60_000)
    t.recordFire('trig-a')
    expect(t.canFire('trig-a')).toBe(false)
  })

  it('allows fire again after cooldown expires', async () => {
    const t = new CooldownTracker(30)
    t.recordFire('trig-a')
    await new Promise(r => setTimeout(r, 50))
    expect(t.canFire('trig-a')).toBe(true)
  })

  it('per-trigger cooldown override', () => {
    const t = new CooldownTracker(60_000, { 'trig-special': 1 })
    t.recordFire('trig-special')
    // Immediate retry — short cooldown of 1ms
    setTimeout(() => {
      expect(t.canFire('trig-special')).toBe(true)
    }, 5)
  })

  it('different triggers do not block each other', () => {
    const t = new CooldownTracker(60_000)
    t.recordFire('trig-a')
    expect(t.canFire('trig-b')).toBe(true)
  })

  it('reset clears all cooldowns', () => {
    const t = new CooldownTracker(60_000)
    t.recordFire('trig-a')
    t.reset()
    expect(t.canFire('trig-a')).toBe(true)
  })
})

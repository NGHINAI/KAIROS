// src/daemon/restraint/focusDetector.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { FocusDetector } from './focusDetector'
import type { RestraintConfig } from './types'

const baseConfig: Partial<RestraintConfig> = {
  quiet_hours_start: '22:00',
  quiet_hours_end: '07:00',
  deep_focus_threshold_sec: 1500,
}

describe('FocusDetector', () => {
  let detector: FocusDetector

  beforeEach(() => {
    detector = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),  // 10 AM, not quiet hours
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 600 }),  // 10 min focus
      probeMeeting: async () => false,
    })
  })

  it('reports current focus state with no pause', async () => {
    const state = await detector.state()
    expect(state.current_app).toBe('VS Code')
    expect(state.app_duration_sec).toBe(600)
    expect(state.in_deep_focus).toBe(false)
    expect(state.in_meeting).toBe(false)
    expect(state.in_quiet_hours).toBe(false)
    expect(state.pause_until).toBeNull()
  })

  it('detects deep focus when app duration exceeds threshold', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 1800 }),  // 30 min
      probeMeeting: async () => false,
    })
    const state = await d.state()
    expect(state.in_deep_focus).toBe(true)
  })

  it('detects quiet hours during night', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T23:30:00').getTime(),  // 11:30 PM
      probeFocusedApp: async () => ({ app: '', duration_sec: 0 }),
      probeMeeting: async () => false,
    })
    const state = await d.state()
    expect(state.in_quiet_hours).toBe(true)
  })

  it('detects quiet hours during early morning', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T05:30:00').getTime(),  // 5:30 AM
      probeFocusedApp: async () => ({ app: '', duration_sec: 0 }),
      probeMeeting: async () => false,
    })
    const state = await d.state()
    expect(state.in_quiet_hours).toBe(true)
  })

  it('respects manual pause until expiry', async () => {
    const futureTs = new Date('2026-05-25T10:00:00').getTime() + 600_000  // 10 min from "now"
    detector.pauseUntil(futureTs)
    const state = await detector.state()
    expect(state.pause_until).toBe(futureTs)
  })

  it('shouldSuppress returns true in deep focus for non-urgent', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T10:00:00').getTime(),
      probeFocusedApp: async () => ({ app: 'VS Code', duration_sec: 1800 }),
      probeMeeting: async () => false,
    })
    expect(await d.shouldSuppress({ urgent: false })).toBe(true)
    expect(await d.shouldSuppress({ urgent: true })).toBe(false)
  })

  it('shouldSuppress returns true during quiet hours for non-urgent', async () => {
    const d = new FocusDetector(baseConfig as RestraintConfig, {
      now: () => new Date('2026-05-25T23:30:00').getTime(),
      probeFocusedApp: async () => ({ app: '', duration_sec: 0 }),
      probeMeeting: async () => false,
    })
    expect(await d.shouldSuppress({ urgent: false })).toBe(true)
  })
})

import { describe, it, expect } from 'bun:test'
import { personaThresholdShift } from './personaShift'

describe('personaThresholdShift', () => {
  it('returns 0 when hints are null', () => {
    expect(personaThresholdShift(null)).toBe(0)
  })

  it('adds +0.10 for interrupt_aggressiveness=low', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'low', in_focus_now: false, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.10)
  })

  it('subtracts -0.05 for interrupt_aggressiveness=high', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'high', in_focus_now: false, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(-0.05)
  })

  it('adds +0.05 for in_focus_now=true', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'medium', in_focus_now: true, active_hours_now: true, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.05)
  })

  it('adds +0.10 when active_hours_now=false', () => {
    expect(personaThresholdShift({ interrupt_aggressiveness: 'medium', in_focus_now: false, active_hours_now: false, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.10)
  })

  it('clamps combined shift to +0.20', () => {
    // low + in_focus + !active = 0.10 + 0.05 + 0.10 = 0.25 → clamped to 0.20
    expect(personaThresholdShift({ interrupt_aggressiveness: 'low', in_focus_now: true, active_hours_now: false, prefer_terse: false, prefer_voice_over_text: false } as any)).toBe(0.20)
  })
})

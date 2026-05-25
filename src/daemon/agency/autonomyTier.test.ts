import { describe, it, expect } from 'bun:test'
import { tierEmoji, requiresApproval, tierRank, isAtLeast } from './autonomyTier'

describe('autonomyTier helpers', () => {
  it('maps each tier to its emoji', () => {
    expect(tierEmoji('GREEN')).toBe('🟢')
    expect(tierEmoji('YELLOW')).toBe('🟡')
    expect(tierEmoji('ORANGE')).toBe('🟠')
    expect(tierEmoji('RED')).toBe('🔴')
  })

  it('ORANGE and RED require approval; GREEN and YELLOW do not', () => {
    expect(requiresApproval('GREEN')).toBe(false)
    expect(requiresApproval('YELLOW')).toBe(false)
    expect(requiresApproval('ORANGE')).toBe(true)
    expect(requiresApproval('RED')).toBe(true)
  })

  it('tierRank orders GREEN < YELLOW < ORANGE < RED', () => {
    expect(tierRank('GREEN')).toBeLessThan(tierRank('YELLOW'))
    expect(tierRank('YELLOW')).toBeLessThan(tierRank('ORANGE'))
    expect(tierRank('ORANGE')).toBeLessThan(tierRank('RED'))
  })

  it('isAtLeast checks tier severity ≥ threshold', () => {
    expect(isAtLeast('ORANGE', 'YELLOW')).toBe(true)
    expect(isAtLeast('GREEN', 'ORANGE')).toBe(false)
    expect(isAtLeast('RED', 'RED')).toBe(true)
  })
})

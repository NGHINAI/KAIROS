// src/daemon/agency/intentRegistry.test.ts
import { describe, it, expect } from 'bun:test'
import { IntentRegistry, registerBuiltIns } from './intentRegistry'

describe('IntentRegistry', () => {
  it('registers all built-in intents', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    const ids = reg.list().map(i => i.id).sort()
    expect(ids).toEqual(['add_to_memory', 'log', 'notify', 'remind_in', 'suspend'])
  })

  it('lookup by id returns the full intent', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    const notify = reg.get('notify')
    expect(notify?.intent.id).toBe('notify')
    expect(notify?.intent.tier).toBe('GREEN')
    expect(typeof notify?.handler).toBe('function')
  })

  it('returns null for unknown intent id', () => {
    const reg = new IntentRegistry()
    expect(reg.get('nonexistent')).toBeNull()
  })

  it('rejects duplicate registration', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    expect(() => registerBuiltIns(reg)).toThrow()
  })

  it('all built-in intents have valid tier + handler', () => {
    const reg = new IntentRegistry()
    registerBuiltIns(reg)
    for (const entry of reg.list()) {
      expect(['GREEN', 'YELLOW', 'ORANGE', 'RED']).toContain(entry.tier)
      expect(typeof reg.get(entry.id)?.handler).toBe('function')
    }
  })
})

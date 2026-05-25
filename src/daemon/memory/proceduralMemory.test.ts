// src/daemon/memory/proceduralMemory.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initMemorySchema } from './schema'
import { ProceduralMemory } from './proceduralMemory'

describe('ProceduralMemory', () => {
  let db: Database
  let mem: ProceduralMemory

  beforeEach(() => {
    db = new Database(':memory:')
    initMemorySchema(db)
    mem = new ProceduralMemory(db)
  })

  it('registers a skill and retrieves by id', () => {
    mem.register({
      skill_id: 'system-info',
      description: 'Show host system info',
      trigger_pattern: 'user asks "what system" or "specs"',
    })
    const row = mem.get('system-info')
    expect(row?.description).toBe('Show host system info')
  })

  it('records invocation + success', () => {
    mem.register({ skill_id: 'x', description: 'y' })
    mem.recordInvoke('x', true)
    mem.recordInvoke('x', true)
    mem.recordInvoke('x', false)
    const row = mem.get('x')
    expect(row?.invoke_count).toBe(3)
    expect(row?.success_count).toBe(2)
  })

  it('lists skills ordered by recent + frequent usage', () => {
    mem.register({ skill_id: 'a', description: 'a' })
    mem.register({ skill_id: 'b', description: 'b' })
    mem.recordInvoke('b', true)
    mem.recordInvoke('b', true)
    mem.recordInvoke('a', true)
    const top = mem.topUsed(5)
    expect(top[0]?.skill_id).toBe('b')
  })
})

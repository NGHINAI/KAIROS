import { describe, it, expect, beforeEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { FlowStateStore } from './flowStateStore'
import type { FlowState } from './types'

function sampleFlow(overrides: Partial<FlowState> = {}): FlowState {
  return {
    flow_id: 'flow-1',
    service_name: 'github',
    current_step_index: 0,
    started_at: 1_000_000,
    status: 'executing',
    collected_data: {},
    ...overrides,
  }
}

describe('FlowStateStore', () => {
  let db: Database
  let store: FlowStateStore
  beforeEach(() => {
    db = new Database(':memory:')
    store = new FlowStateStore(db)
  })

  it('creates and retrieves a flow', () => {
    store.create(sampleFlow())
    const got = store.get('flow-1')
    expect(got?.service_name).toBe('github')
    expect(got?.current_step_index).toBe(0)
    expect(got?.collected_data).toEqual({})
  })

  it('returns null for missing flow', () => {
    expect(store.get('nope')).toBeNull()
  })

  it('updateStepIndex advances the flow', () => {
    store.create(sampleFlow())
    store.updateStepIndex('flow-1', 3)
    expect(store.get('flow-1')?.current_step_index).toBe(3)
  })

  it('markCompleted sets status + completed_at', () => {
    store.create(sampleFlow())
    store.markCompleted('flow-1')
    const got = store.get('flow-1')!
    expect(got.status).toBe('completed')
    expect(got.completed_at).toBeGreaterThan(0)
  })

  it('setCollectedData merges into existing', () => {
    store.create(sampleFlow({ collected_data: { a: 1 } }))
    store.setCollectedData('flow-1', { b: 2 })
    expect(store.get('flow-1')?.collected_data).toEqual({ a: 1, b: 2 })
  })

  it('listActive returns only awaiting_user + executing flows', () => {
    store.create(sampleFlow({ flow_id: 'a', status: 'executing' }))
    store.create(sampleFlow({ flow_id: 'b', status: 'awaiting_user' }))
    store.create(sampleFlow({ flow_id: 'c', status: 'completed' }))
    store.create(sampleFlow({ flow_id: 'd', status: 'failed' }))
    const active = store.listActive()
    expect(active.map(f => f.flow_id).sort()).toEqual(['a', 'b'])
  })
})

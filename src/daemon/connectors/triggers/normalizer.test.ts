// src/daemon/connectors/triggers/normalizer.test.ts
import { describe, it, expect } from 'bun:test'
import { TriggerNormalizer } from './normalizer'

describe('TriggerNormalizer', () => {
  it('normalizes a Gmail payload', () => {
    const n = new TriggerNormalizer()
    const env = n.normalize({
      triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
      toolkitSlug: 'gmail',
      id: 'evt-1',
      connectedAccountId: 'ca_1',
      userId: 'local',
      data: { from: 'mark@cuban.com', subject: 'hi' },
    })
    expect(env.trigger_slug).toBe('GMAIL_NEW_GMAIL_MESSAGE')
    expect(env.toolkit).toBe('gmail')
    expect(env.event_id).toBe('evt-1')
    expect(env.payload).toEqual({ from: 'mark@cuban.com', subject: 'hi' })
    expect(env.connected_account_id).toBe('ca_1')
  })

  it('derives event_id from hash when not provided', () => {
    const n = new TriggerNormalizer()
    const env = n.normalize({
      triggerSlug: 'X', toolkitSlug: 'x',
      data: { some: 'data' },
    })
    expect(env.event_id).toBeDefined()
    expect(env.event_id.length).toBeGreaterThan(0)
  })

  it('falls back to stripped raw as payload when data field missing', () => {
    const n = new TriggerNormalizer()
    const env = n.normalize({
      triggerSlug: 'Y', toolkitSlug: 'y',
      from: 'x', subject: 'y',
    } as any)
    expect(env.payload.from).toBe('x')
  })

  it('uses lowercase toolkit', () => {
    const n = new TriggerNormalizer()
    const env = n.normalize({ triggerSlug: 'X_Y', toolkitSlug: 'GitHub', data: {} })
    expect(env.toolkit).toBe('github')
  })

  it('sets received_at to now', () => {
    const n = new TriggerNormalizer()
    const before = Date.now()
    const env = n.normalize({ triggerSlug: 'X', toolkitSlug: 'x', data: {} })
    const after = Date.now()
    expect(env.received_at).toBeGreaterThanOrEqual(before)
    expect(env.received_at).toBeLessThanOrEqual(after)
  })

  it('preserves raw payload', () => {
    const n = new TriggerNormalizer()
    const raw = { triggerSlug: 'X', toolkitSlug: 'x', data: { a: 1 } }
    const env = n.normalize(raw)
    expect(env.raw).toEqual(raw)
  })
})

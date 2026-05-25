// src/daemon/restraint/urgencyFloor.test.ts
import { describe, it, expect } from 'bun:test'
import { UrgencyFloor } from './urgencyFloor'
import type { ActionRequest } from '../agency/types'

function req(intent: string, args: Record<string, unknown> = {}, extras: Partial<ActionRequest> = {}): ActionRequest {
  return {
    request_id: 'r', intent_id: intent, args, reasoning: '',
    requested_at: Date.now(), ...extras,
  }
}

describe('UrgencyFloor', () => {
  it('returns false for ordinary request', () => {
    const f = new UrgencyFloor()
    expect(f.classify(req('notify', { title: 'hi' }))).toBe(false)
  })

  it('returns true when intent is system_critical', () => {
    const f = new UrgencyFloor()
    expect(f.classify(req('system_critical', { kind: 'low_disk' }))).toBe(true)
  })

  it('returns true when request marks always_interrupt', () => {
    const f = new UrgencyFloor()
    expect(f.classify(req('notify', {}, { always_interrupt: true } as any))).toBe(true)
  })

  it('detects calendar event starting in < 5 min', () => {
    const f = new UrgencyFloor()
    const soon = Date.now() + 3 * 60_000   // 3 min from now
    expect(f.classify(req('notify', { kind: 'calendar', starts_at: soon }))).toBe(true)
  })

  it('does not flag calendar event > 5 min away', () => {
    const f = new UrgencyFloor()
    const later = Date.now() + 30 * 60_000   // 30 min
    expect(f.classify(req('notify', { kind: 'calendar', starts_at: later }))).toBe(false)
  })

  it('detects password-like content in clipboard payload', () => {
    const f = new UrgencyFloor()
    // SK_-style API key
    expect(f.classify(req('add_to_memory', { kind: 'clipboard', body: 'sk-proj-AbCdEf1234567890XyZ12345678' }))).toBe(true)
    // GitHub PAT
    expect(f.classify(req('add_to_memory', { kind: 'clipboard', body: 'ghp_AbCdEf1234567890XyZ12345678901234' }))).toBe(true)
    // SSH private key marker
    expect(f.classify(req('add_to_memory', { kind: 'clipboard', body: '-----BEGIN PRIVATE KEY-----' }))).toBe(true)
    // Plain text — not urgent
    expect(f.classify(req('add_to_memory', { kind: 'clipboard', body: 'hello world' }))).toBe(false)
  })

  it('detects direct @mention of user', () => {
    const f = new UrgencyFloor({ user_handles: ['nirmal', 'nghinai'] })
    expect(f.classify(req('notify', { body: 'Hey @nirmal can you check this?' }))).toBe(true)
    expect(f.classify(req('notify', { body: 'Hey @somebody-else check this' }))).toBe(false)
  })

  it('detects urgent keyword in reasoning', () => {
    const f = new UrgencyFloor()
    expect(f.classify(req('notify', {}, { reasoning: 'URGENT: server is down' }))).toBe(true)
    expect(f.classify(req('notify', {}, { reasoning: 'ASAP please review' }))).toBe(true)
    expect(f.classify(req('notify', {}, { reasoning: 'fyi at some point' }))).toBe(false)
  })

  it('detects active-task error pattern', () => {
    const f = new UrgencyFloor()
    expect(f.classify(req('notify', { kind: 'task_error', task_id: 't1', error: 'something failed' }))).toBe(true)
  })
})

// src/daemon/orders/v2/conditionEvaluator.test.ts
import { describe, it, expect, beforeEach } from 'bun:test'
import { ConditionEvaluator } from './conditionEvaluator'

describe('ConditionEvaluator', () => {
  let ev: ConditionEvaluator
  beforeEach(() => { ev = new ConditionEvaluator() })

  it('evaluates bare boolean identifier', () => {
    expect(ev.evaluate('persona.is_in_meeting', { persona: { is_in_meeting: true } })).toBe(true)
    expect(ev.evaluate('persona.is_in_meeting', { persona: { is_in_meeting: false } })).toBe(false)
  })

  it('treats missing keys as false', () => {
    expect(ev.evaluate('persona.missing', { persona: {} })).toBe(false)
  })

  it('evaluates string equality', () => {
    expect(ev.evaluate('persona.focus_app == "Slack"', { persona: { focus_app: 'Slack' } })).toBe(true)
    expect(ev.evaluate('persona.focus_app == "Slack"', { persona: { focus_app: 'Code' } })).toBe(false)
  })

  it('evaluates numeric comparison', () => {
    expect(ev.evaluate('persona.current_hour > 9', { persona: { current_hour: 14 } })).toBe(true)
    expect(ev.evaluate('persona.current_hour > 9', { persona: { current_hour: 5 } })).toBe(false)
  })

  it('evaluates && and ||', () => {
    expect(ev.evaluate('persona.a && persona.b', { persona: { a: true, b: true } })).toBe(true)
    expect(ev.evaluate('persona.a && persona.b', { persona: { a: true, b: false } })).toBe(false)
    expect(ev.evaluate('persona.a || persona.b', { persona: { a: false, b: true } })).toBe(true)
  })

  it('evaluates ! (negation)', () => {
    expect(ev.evaluate('!persona.is_in_meeting', { persona: { is_in_meeting: false } })).toBe(true)
  })

  it('evaluates time.between("22:00","07:00")', () => {
    const at23 = new Date(2026, 0, 1, 23, 30).getTime()
    expect(ev.evaluate('time.between("22:00","07:00")', { now: at23 })).toBe(true)
    const at12 = new Date(2026, 0, 1, 12, 0).getTime()
    expect(ev.evaluate('time.between("22:00","07:00")', { now: at12 })).toBe(false)
  })

  it('evaluates payload.X comparison', () => {
    expect(ev.evaluate('payload.importance == "high"', { payload: { importance: 'high' } })).toBe(true)
  })

  it('rejects unknown function call', () => {
    expect(() => ev.evaluate('os.execSync("rm -rf /")', {})).toThrow(/not allowed/i)
  })

  it('rejects raw JS expressions', () => {
    expect(() => ev.evaluate('1; console.log(1)', {})).toThrow()
  })

  it('any() returns true if any condition true', () => {
    expect(ev.any(['persona.a', 'persona.b'], { persona: { a: false, b: true } })).toBe(true)
    expect(ev.any(['persona.a', 'persona.b'], { persona: { a: false, b: false } })).toBe(false)
  })

  it('all() returns true only if every condition true', () => {
    expect(ev.all(['persona.a', 'persona.b'], { persona: { a: true, b: true } })).toBe(true)
    expect(ev.all(['persona.a', 'persona.b'], { persona: { a: true, b: false } })).toBe(false)
  })
})

// src/daemon/orders/v2/interp.test.ts
import { describe, it, expect } from 'bun:test'
import { interpolate, interpolateObject } from './interp'

describe('interpolate', () => {
  it('substitutes ${trigger.X}', () => {
    expect(interpolate('hello ${trigger.name}', { trigger: { name: 'world' } })).toBe('hello world')
  })

  it('substitutes nested paths ${trigger.user.email}', () => {
    expect(interpolate('${trigger.user.email}', { trigger: { user: { email: 'x@y.z' } } })).toBe('x@y.z')
  })

  it('substitutes ${payload.X}', () => {
    expect(interpolate('${payload.foo}', { trigger: {}, payload: { foo: 'bar' } })).toBe('bar')
  })

  it('substitutes ${skill_output.X}', () => {
    expect(interpolate('${skill_output.result}', { trigger: {}, skill_output: { result: 'ok' } })).toBe('ok')
  })

  it('substitutes ${persona.X}', () => {
    expect(interpolate('${persona.focus_app}', { trigger: {}, persona: { focus_app: 'Slack' } })).toBe('Slack')
  })

  it('returns empty string and records warning for missing keys', () => {
    const warnings: string[] = []
    const result = interpolate('${trigger.missing}', { trigger: {} }, { onWarn: w => warnings.push(w) })
    expect(result).toBe('')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('missing')
  })

  it('handles multiple substitutions in one string', () => {
    expect(interpolate('${trigger.a}-${trigger.b}', { trigger: { a: '1', b: '2' } })).toBe('1-2')
  })

  it('passes through strings with no ${}', () => {
    expect(interpolate('hello', {})).toBe('hello')
  })

  it('interpolateObject walks objects + arrays', () => {
    const result = interpolateObject({ msg: 'hi ${trigger.name}', tags: ['${trigger.tag}'] }, { trigger: { name: 'world', tag: 'urgent' } })
    expect(result).toEqual({ msg: 'hi world', tags: ['urgent'] })
  })
})

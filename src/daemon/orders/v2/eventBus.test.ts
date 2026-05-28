import { describe, it, expect } from 'bun:test'
import { RulesEventBus } from './eventBus'

describe('RulesEventBus', () => {
  it('emit/on delivers payload', () => {
    const bus = new RulesEventBus()
    const received: Record<string, unknown>[] = []
    bus.on('foo', p => received.push(p))
    bus.emit('foo', { x: 1 })
    expect(received).toEqual([{ x: 1 }])
  })

  it('multiple listeners receive', () => {
    const bus = new RulesEventBus()
    let a = 0, b = 0
    bus.on('foo', () => a++)
    bus.on('foo', () => b++)
    bus.emit('foo', {})
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('off removes listener', () => {
    const bus = new RulesEventBus()
    let calls = 0
    const fn = () => calls++
    bus.on('foo', fn)
    bus.emit('foo', {})
    bus.off('foo', fn)
    bus.emit('foo', {})
    expect(calls).toBe(1)
  })

  it('emit with no listeners is a no-op', () => {
    expect(() => new RulesEventBus().emit('foo', {})).not.toThrow()
  })

  it('chain loop guard refuses depth > 10', () => {
    const bus = new RulesEventBus()
    let depth = 0
    bus.on('loop', () => {
      depth++
      bus.emit('loop', {})
    })
    bus.emit('loop', {})
    expect(depth).toBe(10)
  })

  it('listenerCount returns listener count for event', () => {
    const bus = new RulesEventBus()
    bus.on('foo', () => {})
    bus.on('foo', () => {})
    expect(bus.listenerCount('foo')).toBe(2)
    expect(bus.listenerCount('bar')).toBe(0)
  })
})

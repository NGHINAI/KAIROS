import { describe, it, expect } from 'bun:test'
import { NativeNotifier } from './nativeNotifier'

describe('NativeNotifier', () => {
  it('forwards args to the probe', async () => {
    const calls: Array<{ title: string; body: string }> = []
    const notifier = new NativeNotifier({
      probe: async (args) => { calls.push(args) },
    })
    await notifier.notify({ title: 'hello', body: 'world', urgency: 'normal' })
    expect(calls).toEqual([{ title: 'hello', body: 'world' }])
  })

  it('escapes single quotes safely', async () => {
    const calls: Array<string> = []
    const notifier = new NativeNotifier({
      probe: async (args) => { calls.push(`${args.title}|${args.body}`) },
    })
    await notifier.notify({ title: "it's", body: "don't" })
    expect(calls[0]).toBe("it's|don't")
  })

  it('does not throw on osascript failure (best-effort surface)', async () => {
    const notifier = new NativeNotifier({
      probe: async () => { throw new Error('osascript failed') },
    })
    await expect(notifier.notify({ title: 'x', body: 'y' })).resolves.toBeUndefined()
  })
})

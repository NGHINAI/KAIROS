import { describe, it, expect } from 'bun:test'
import { NativeNotifier, escapeForAppleScript } from './nativeNotifier'

describe('escapeForAppleScript', () => {
  it('escapes double quotes (the bug that broke real trigger notifications)', () => {
    expect(escapeForAppleScript('a "quoted" thing')).toBe('a \\"quoted\\" thing')
  })

  it('escapes backslashes before double quotes', () => {
    expect(escapeForAppleScript('a \\ b "c"')).toBe('a \\\\ b \\"c\\"')
  })

  it('flattens newlines to spaces', () => {
    expect(escapeForAppleScript('line one\nline two\r\nline three')).toBe('line one line two line three')
  })

  it('leaves single quotes untouched (AppleScript only delimits with double quotes)', () => {
    expect(escapeForAppleScript("it's a thing")).toBe("it's a thing")
  })

  it('handles real trigger payload that broke production (JSON in body)', () => {
    const body = 'focus-app/app_changed: {"app":"Slack"}'
    const out = escapeForAppleScript(body)
    expect(out).not.toContain('"app"')   // raw " gone
    expect(out).toContain('\\"app\\"')
  })
})

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

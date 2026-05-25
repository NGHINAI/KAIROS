import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { InboxUserChannel } from './inboxUserChannel'

describe('InboxUserChannel', () => {
  let tmp: string
  let path: string
  let ch: InboxUserChannel

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-inbox-'))
    path = join(tmp, 'chat.md')
    ch = new InboxUserChannel({ path, pollIntervalMs: 25 })
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('speak appends a KAIROS line', async () => {
    await ch.speak('Hello user')
    const text = readFileSync(path, 'utf8')
    expect(text).toMatch(/KAIROS: Hello user/)
  })

  it('notifyProgress appends step/total + label', async () => {
    await ch.notifyProgress(2, 5, 'Installing server')
    const text = readFileSync(path, 'utf8')
    expect(text).toMatch(/KAIROS \[2\/5\]: Installing server/)
  })

  it('notifyComplete writes success marker', async () => {
    await ch.notifyComplete('github', 'connected')
    expect(readFileSync(path, 'utf8')).toMatch(/KAIROS ✓: github — connected/)
  })

  it('notifyFailed writes error and remedy when given', async () => {
    await ch.notifyFailed('slack', 'invalid token', 'regenerate scope user:read')
    const text = readFileSync(path, 'utf8')
    expect(text).toMatch(/KAIROS ✗: slack — invalid token/)
    expect(text).toMatch(/KAIROS remedy: regenerate scope user:read/)
  })

  it('awaitConfirm resolves true when USER replies yes', async () => {
    // Write reply AFTER awaitConfirm starts polling
    setTimeout(() => { appendFileSync(path, '\nUSER: yes\n') }, 60)
    const result = await ch.awaitConfirm('Proceed?')
    expect(result).toBe(true)
  })

  it('awaitConfirm resolves false when USER replies no', async () => {
    setTimeout(() => { appendFileSync(path, '\nUSER: n\n') }, 60)
    const result = await ch.awaitConfirm('Proceed?', 'yes')
    expect(result).toBe(false)
  })

  it('awaitConfirm ignores replies that came BEFORE the prompt', async () => {
    appendFileSync(path, 'USER: yes\n')
    // The pre-existing yes should be ignored. Only post-prompt USER lines count.
    setTimeout(() => { appendFileSync(path, '\nUSER: no\n') }, 60)
    const result = await ch.awaitConfirm('Proceed?')
    expect(result).toBe(false)
  })
})

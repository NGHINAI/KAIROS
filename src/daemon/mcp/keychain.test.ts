import { describe, it, expect } from 'bun:test'
import { Keychain } from './keychain'

describe('Keychain', () => {
  it('uses injected probe for testability', async () => {
    const calls: string[] = []
    const kc = new Keychain({
      probe: async (cmd) => { calls.push(cmd.join(' ')); return { ok: true, stdout: 'fake-secret-value', stderr: '' } },
    })
    const value = await kc.get('com.kairos.test', 'github')
    expect(value).toBe('fake-secret-value')
    expect(calls[0]).toContain('find-generic-password')
    expect(calls[0]).toContain('com.kairos.test')
    expect(calls[0]).toContain('github')
  })

  it('returns null when keychain item is missing', async () => {
    const kc = new Keychain({
      probe: async () => ({ ok: false, stdout: '', stderr: 'SecKeychainSearchCopyNext: The specified item could not be found' }),
    })
    expect(await kc.get('com.kairos.nope', 'nope')).toBeNull()
  })

  it('set() writes (delete-then-add) so updates work', async () => {
    const calls: string[][] = []
    const kc = new Keychain({
      probe: async (cmd) => { calls.push(cmd); return { ok: true, stdout: '', stderr: '' } },
    })
    await kc.set('com.kairos.test', 'github', 'new-token')
    expect(calls[0]?.join(' ')).toContain('delete-generic-password')
    expect(calls[1]?.join(' ')).toContain('add-generic-password')
    expect(calls[1]?.join(' ')).toContain('new-token')
  })

  it('set() succeeds even when delete fails (first-time write)', async () => {
    let n = 0
    const kc = new Keychain({
      probe: async () => {
        n++
        if (n === 1) return { ok: false, stdout: '', stderr: 'not found' }
        return { ok: true, stdout: '', stderr: '' }
      },
    })
    await expect(kc.set('com.kairos.test', 'gh', 'tok')).resolves.toBeUndefined()
  })
})

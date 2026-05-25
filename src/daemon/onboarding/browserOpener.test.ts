import { describe, it, expect } from 'bun:test'
import { BrowserOpener } from './browserOpener'

describe('BrowserOpener', () => {
  it('opens https URLs via probe', async () => {
    const calls: string[][] = []
    const opener = new BrowserOpener({
      probe: async (cmd) => { calls.push(cmd); return { ok: true, stdout: '', stderr: '' } },
    })
    await opener.open('https://github.com/settings/tokens/new')
    expect(calls[0]).toEqual(['open', 'https://github.com/settings/tokens/new'])
  })

  it('rejects file:// URLs', async () => {
    const opener = new BrowserOpener()
    await expect(opener.open('file:///etc/passwd')).rejects.toThrow(/disallowed/)
  })

  it('rejects javascript: URLs', async () => {
    const opener = new BrowserOpener()
    await expect(opener.open('javascript:alert(1)')).rejects.toThrow(/disallowed/)
  })

  it('rejects non-http schemes', async () => {
    const opener = new BrowserOpener()
    await expect(opener.open('ftp://example.com')).rejects.toThrow(/disallowed/)
  })

  it('accepts http and https', async () => {
    const calls: string[][] = []
    const opener = new BrowserOpener({
      probe: async (cmd) => { calls.push(cmd); return { ok: true, stdout: '', stderr: '' } },
    })
    await opener.open('http://localhost:9999/oauth-callback?code=abc')
    await opener.open('https://github.com')
    expect(calls.length).toBe(2)
  })
})

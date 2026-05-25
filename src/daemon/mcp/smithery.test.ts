import { describe, it, expect } from 'bun:test'
import { SmitheryCli } from './smithery'

describe('SmitheryCli', () => {
  it('isAvailable() returns false when smithery is not installed', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({ ok: false, stdout: '', stderr: 'command not found' }),
    })
    expect(await cli.isAvailable()).toBe(false)
  })

  it('isAvailable() returns true when smithery --version succeeds', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({ ok: true, stdout: '1.2.3', stderr: '' }),
    })
    expect(await cli.isAvailable()).toBe(true)
  })

  it('search() parses JSON output into SmitherySearchHit array', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({
        ok: true,
        stdout: JSON.stringify([
          { qualifiedName: 'github', name: 'github', description: 'GitHub MCP server', installCount: 5000, url: 'https://server.smithery.ai/github' },
          { qualifiedName: 'slack', name: 'slack', description: 'Slack', installCount: 3000, url: 'https://server.smithery.ai/slack' },
        ]),
        stderr: '',
      }),
    })
    const hits = await cli.search('messaging')
    expect(hits.length).toBe(2)
    expect(hits[0]?.qualified_name).toBe('github')
    expect(hits[0]?.install_count).toBe(5000)
  })

  it('search() returns empty array on parse error / smithery error', async () => {
    const cli = new SmitheryCli({
      probe: async () => ({ ok: true, stdout: 'not json', stderr: '' }),
    })
    expect(await cli.search('x')).toEqual([])
  })

  it('add() returns success/failure based on probe result', async () => {
    const ok = new SmitheryCli({ probe: async () => ({ ok: true, stdout: 'installed', stderr: '' }) })
    expect((await ok.add('github')).ok).toBe(true)
    const fail = new SmitheryCli({ probe: async () => ({ ok: false, stdout: '', stderr: 'auth required' }) })
    const r = await fail.add('github')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('auth required')
  })
})

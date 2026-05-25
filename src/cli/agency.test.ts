import { describe, it, expect, beforeEach } from 'bun:test'
import { runAgencyCommand } from './agency'

describe('agency CLI', () => {
  let posts: Array<{ url: string; body: any }>
  let originalFetch: typeof fetch

  beforeEach(() => {
    posts = []
    originalFetch = globalThis.fetch
    ;(globalThis as any).fetch = async (url: string, init: any) => {
      posts.push({ url, body: JSON.parse(init.body) })
      return { ok: true, json: async () => ({ status: 'completed' }) } as any
    }
  })

  it('approve posts to the daemon with item_id', async () => {
    const result = await runAgencyCommand(['approve', 'abc-123'], { daemonUrl: 'http://localhost:9876' })
    expect(posts[0]?.url).toBe('http://localhost:9876/agency/approve')
    expect(posts[0]?.body).toEqual({ item_id: 'abc-123' })
    expect(result.exitCode).toBe(0)
    globalThis.fetch = originalFetch
  })

  it('dismiss posts to the daemon with item_id + reason', async () => {
    await runAgencyCommand(['dismiss', 'abc-123', 'user said no'], { daemonUrl: 'http://localhost:9876' })
    expect(posts[0]?.url).toBe('http://localhost:9876/agency/dismiss')
    expect(posts[0]?.body).toEqual({ item_id: 'abc-123', reason: 'user said no' })
    globalThis.fetch = originalFetch
  })

  it('dismiss without explicit reason supplies a default', async () => {
    await runAgencyCommand(['dismiss', 'abc-123'], { daemonUrl: 'http://localhost:9876' })
    expect(posts[0]?.body.reason).toBe('user dismissed')
    globalThis.fetch = originalFetch
  })

  it('returns non-zero exit on missing arguments', async () => {
    const result = await runAgencyCommand(['approve'], { daemonUrl: 'http://localhost:9876' })
    expect(result.exitCode).not.toBe(0)
    globalThis.fetch = originalFetch
  })

  it('returns non-zero exit on unknown command', async () => {
    const result = await runAgencyCommand(['nope'], { daemonUrl: 'http://localhost:9876' })
    expect(result.exitCode).not.toBe(0)
    globalThis.fetch = originalFetch
  })

  it('returns non-zero exit when daemon is unreachable', async () => {
    ;(globalThis as any).fetch = async () => { throw new Error('ECONNREFUSED') }
    const result = await runAgencyCommand(['approve', 'abc'], { daemonUrl: 'http://localhost:9876' })
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain('unreachable')
    globalThis.fetch = originalFetch
  })
})

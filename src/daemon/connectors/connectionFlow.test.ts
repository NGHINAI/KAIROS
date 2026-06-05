import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { ConnectionFlow } from './connectionFlow'
import { ConnectionStore } from './connectionStore'

function makeDeps(overrides: any = {}) {
  const db = new Database(':memory:')
  return {
    composio: {
      getOrCreateAuthConfig: async (slug: string) => `ac_${slug}`,
      linkConnection: async (args: any) => ({
        connection_id: 'c_abc',
        redirect_url: 'https://composio.dev/auth/slack/...',
        status: 'pending',
        _raw: { waitForConnection: async (_ms: number) => ({ id: 'c_abc', status: 'ACTIVE' }) },
      }),
      listConnectedAccounts: async () => [],
      sdk: {
        toolkits: {
          get: async (slug: string) => ({
            tools: [
              { name: `${slug}_send_message` },
              { name: `${slug}_list_channels` },
              { name: `${slug}_search_threads` },
            ],
          }),
        },
      },
    },
    browserOpener: { open: async (_url: string) => {} },
    oauthCallbackHandler: {
      listen: async (opts: any) => ({
        port: 12345, callbackUrl: 'http://localhost:12345/composio-cb',
        capturePromise: Promise.resolve({ callback_path: '/composio-cb', query_params: { status: 'success' }, raw_url: '', captured_at: Date.now() }),
      }),
    },
    connectionStore: new ConnectionStore(db),
    ...overrides,
  }
}

describe('ConnectionFlow', () => {
  it('connects a Slack-like OAuth toolkit end-to-end', async () => {
    const deps = makeDeps()
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('success')
    expect(result.connection_id).toBe('c_abc')
    expect(deps.connectionStore.getByToolkit('local', 'slack')?.status).toBe('active')
  })

  it('already-connected toolkit short-circuits — no second OAuth/browser flow', async () => {
    const opens: string[] = []
    const deps = makeDeps({ browserOpener: { open: async (url: string) => { opens.push(url) } } })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' }) // first connect → active
    expect(opens.length).toBe(1)
    const again = await flow.connect({ userId: 'local', toolkitSlug: 'slack' }) // second → should short-circuit
    expect(again.status).toBe('success')
    expect(opens.length).toBe(1) // browser NOT reopened
  })

  it('opens the browser to the redirect_url returned by composio.linkConnection', async () => {
    const opens: string[] = []
    const deps = makeDeps({
      browserOpener: { open: async (url: string) => { opens.push(url) } },
    })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(opens[0]).toMatch(/composio\.dev/)
  })

  it('passes localhost callback URL when calling linkConnection', async () => {
    const linkCalls: any[] = []
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async (args: any) => {
          linkCalls.push(args)
          return { connection_id: 'c', redirect_url: '/x', status: 'pending', _raw: { waitForConnection: async () => ({ status: 'ACTIVE', id: 'c' }) } }
        },
      },
    })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(linkCalls[0].callbackUrl).toMatch(/^http:\/\/localhost:\d+\/composio-cb/)
  })

  it('skips browser for api_key/no_auth toolkits (no redirect_url)', async () => {
    const opens: string[] = []
    const deps = makeDeps({
      browserOpener: { open: async (url: string) => { opens.push(url) } },
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c_api', status: 'active', _raw: { waitForConnection: async () => ({ id: 'c_api', status: 'ACTIVE' }) },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'openai' })
    expect(result.status).toBe('success')
    expect(opens.length).toBe(0)
  })

  it('returns failed if waitForConnection rejects', async () => {
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c', redirect_url: 'https://...', status: 'pending',
          _raw: { waitForConnection: async () => { throw new Error('TIMEOUT') } },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/TIMEOUT|active within 30s/)
  })

  it('returns failed if waitForConnection settles in non-ACTIVE status', async () => {
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c', redirect_url: 'https://...', status: 'pending',
          _raw: { waitForConnection: async () => ({ id: 'c', status: 'FAILED' }) },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/non-active|FAILED/i)
  })

  it('does not insert a stale row into ConnectionStore on failure', async () => {
    const deps = makeDeps({
      composio: {
        ...makeDeps().composio,
        linkConnection: async () => ({
          connection_id: 'c', redirect_url: 'https://...', status: 'pending',
          _raw: { waitForConnection: async () => { throw new Error('TIMEOUT') } },
        }),
      },
    })
    const flow = new ConnectionFlow(deps as any)
    await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(deps.connectionStore.getByToolkit('local', 'slack')).toBeNull()
  })

  it('V2: fires postConnectionAnnouncement on success with verb-rich text', async () => {
    const announcements: any[] = []
    const deps = makeDeps({
      announcer: { announce: async (text: string, opts: any) => { announcements.push({ text, opts }) } },
    })
    const flow = new ConnectionFlow(deps as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.status).toBe('success')
    expect(announcements.length).toBe(1)
    expect(announcements[0].text).toMatch(/Slack connected\./)
    // Should include at least one of the sample verbs
    expect(announcements[0].text).toMatch(/send|list|search/i)
    expect(announcements[0].opts.toolkit_slug).toBe('slack')
  })

  it('records duration_ms', async () => {
    const flow = new ConnectionFlow(makeDeps() as any)
    const result = await flow.connect({ userId: 'local', toolkitSlug: 'slack' })
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })
})

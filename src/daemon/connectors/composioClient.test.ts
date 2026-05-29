import { describe, it, expect } from 'bun:test'
import { ComposioClient } from './composioClient'

describe('ComposioClient', () => {
  it('throws when no API key is provided', () => {
    expect(() => new ComposioClient({ apiKey: '' })).toThrow(/api[_ ]?key/i)
  })

  it('exposes the SDK as `sdk` property for low-level access', () => {
    const c = new ComposioClient({ apiKey: 'test_key' })
    expect(c.sdk).toBeDefined()
  })

  it('listToolkits returns shaped results', async () => {
    const fakeSdk: any = {
      toolkits: {
        get: async () => ({ items: [
          { slug: 'slack', name: 'Slack', auth_schemes: ['OAUTH2'], tools_count: 30 },
          { slug: 'openai', name: 'OpenAI', auth_schemes: ['API_KEY'], tools_count: 5 },
        ]}),
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    const result = await c.listToolkits({ limit: 100 })
    expect(result.length).toBe(2)
    expect(result[0].slug).toBe('slack')
    expect(result[0].auth_type).toBe('oauth')
    expect(result[1].auth_type).toBe('api_key')
  })

  it('linkConnection wraps connectedAccounts.link with POSITIONAL args', async () => {
    const calls: any[] = []
    const fakeSdk: any = {
      connectedAccounts: {
        link: async (userId: string, authConfigId: string, options: any) => {
          calls.push({ userId, authConfigId, options })
          return { connection_id: 'conn_abc', redirect_url: 'https://...', waitForConnection: async () => ({ status: 'ACTIVE' }) }
        },
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    const result = await c.linkConnection({ userId: 'u1', authConfigId: 'ac_1', callbackUrl: 'http://localhost:1234/cb' })
    expect(calls[0].userId).toBe('u1')
    expect(calls[0].authConfigId).toBe('ac_1')
    expect(calls[0].options).toEqual({ callbackUrl: 'http://localhost:1234/cb' })
    expect(result.connection_id).toBe('conn_abc')
    expect(result._raw).toBeDefined()
  })

  it('listConnectedAccounts normalizes status enum', async () => {
    const fakeSdk: any = {
      connectedAccounts: {
        list: async () => ({ items: [
          { id: 'c1', toolkit: 'slack', status: 'ACTIVE', auth_config_id: 'ac' },
          { id: 'c2', toolkit: 'gmail', status: 'EXPIRED', auth_config_id: 'ac' },
        ]}),
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    const all = await c.listConnectedAccounts({ userId: 'u1' })
    expect(all.length).toBe(2)
    expect(all[0].status).toBe('active')
    expect(all[1].status).toBe('expired')
  })

  it('does NOT call deprecated initiate()', async () => {
    const fakeSdk: any = {
      connectedAccounts: {
        link: async () => ({ connection_id: 'c1', waitForConnection: async () => ({ status: 'ACTIVE' }) }),
        initiate: async () => { throw new Error('initiate is deprecated — this should never be called') },
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    await c.linkConnection({ userId: 'u1', authConfigId: 'ac_1' })   // must succeed without calling initiate
  })

  it('executeTool uses positional signature (slug, body) with dangerouslySkipVersionCheck=true', async () => {
    // @composio/core@0.10.0 signature: sdk.tools.execute(slug, { userId, arguments, ... }, modifiers).
    // The single-object form silently fails (object passed as slug). Without
    // dangerouslySkipVersionCheck, every manual execute throws TOOL_VERSION_REQUIRED
    // because KAIROS rules implicitly target "latest" tool versions.
    let receivedSlug: any
    let receivedBody: any
    const fakeSdk: any = {
      tools: {
        execute: async (slug: string, body: any) => {
          receivedSlug = slug
          receivedBody = body
          return { successful: true, data: { id: 'msg_1' } }
        },
      },
    }
    const c = new ComposioClient({ apiKey: 'test', _sdk: fakeSdk })
    await c.executeTool({ toolName: 'GMAIL_SEND_EMAIL', userId: 'u1', arguments: { recipient_email: 'x@y.z' } })
    expect(receivedSlug).toBe('GMAIL_SEND_EMAIL')
    expect(receivedBody.userId).toBe('u1')
    expect(receivedBody.arguments).toEqual({ recipient_email: 'x@y.z' })
    expect(receivedBody.dangerouslySkipVersionCheck).toBe(true)
  })
})

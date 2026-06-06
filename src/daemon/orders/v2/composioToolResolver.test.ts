// src/daemon/orders/v2/composioToolResolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ComposioToolResolver } from './composioToolResolver'

// Fake matches @composio/core@0.10.0 actual shape: getRawComposioTools returns a
// bare array of tool descriptors with `slug` (canonical, e.g. 'GMAIL_SEND_EMAIL')
// and `name` (human-readable, e.g. 'Send Email'). We index off `slug`.
function fakeComposio(tools: any[], options: { onListCall?: () => void } = {}) {
  let listCalls = 0
  return {
    sdk: {
      tools: {
        getRawComposioTools: async (_opts: any) => {
          listCalls++
          options.onListCall?.()
          return tools
        },
      },
    },
    getCallCount: () => listCalls,
  } as any
}

describe('ComposioToolResolver', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-resolver-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('initialize populates map from getRawComposioTools', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send Slack message' },
      { toolkit: { slug: 'github' }, slug: 'GITHUB_CREATE_ISSUE', name: 'Create GitHub issue' },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('github', 'create_issue')).toBe('GITHUB_CREATE_ISSUE')
    r.stop()
  })

  it('AGENTIC nature: the model labels each tool read/write, it caches + emits, and never re-classifies', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'gmail' }, slug: 'GMAIL_SEND_EMAIL', name: 'Send Email', description: 'Send an email' },
      { toolkit: { slug: 'gmail' }, slug: 'GMAIL_FETCH_EMAILS', name: 'Fetch Emails', description: 'List recent emails' },
    ])
    let classifyCalls = 0
    const classifyLlm = { complete: async () => { classifyCalls++; return { text: JSON.stringify({ GMAIL_SEND_EMAIL: 'write', GMAIL_FETCH_EMAILS: 'read' }) } } }
    let emitted: Map<string, 'read' | 'write'> | null = null
    const cachePath = join(tmp, 'cache.json')
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath, classifyLlm, onNature: (m) => { emitted = m } })
    await r.initialize()
    expect(r.natureMap().get('GMAIL_SEND_EMAIL')).toBe('write')
    expect(r.natureMap().get('GMAIL_FETCH_EMAILS')).toBe('read')
    expect(emitted!.get('GMAIL_SEND_EMAIL')).toBe('write') // wired out for setToolNature
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).descriptors.GMAIL_SEND_EMAIL.nature).toBe('write') // persisted
    r.stop()

    // Re-init from the fresh cache → natures carried over, NO re-classification.
    classifyCalls = 0
    const r2 = new ComposioToolResolver({ composio: c, userId: 'local', cachePath, classifyLlm, onNature: () => {} })
    await r2.initialize()
    expect(classifyCalls).toBe(0)
    expect(r2.natureMap().get('GMAIL_FETCH_EMAILS')).toBe('read')
    r2.stop()
  })

  it('indexes friendly aliases — stripped toolkit prefix + suffix truncation', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send Slack message' },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('slack', 'message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('slack', 'send')).toBe('SLACK_SEND_MESSAGE')
    r.stop()
  })

  it('resolve returns null for unknown toolkit + tool combinations', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send Slack message' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'create_channel')).toBeNull()
    expect(r.resolve('discord', 'send_message')).toBeNull()
    r.stop()
  })

  it('persists cache to disk (both aliases and descriptors)', async () => {
    const cachePath = join(tmp, 'cache.json')
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send Slack message' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(existsSync(cachePath)).toBe(true)
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cached.aliases).toBeDefined()
    expect(Object.keys(cached.aliases).length).toBeGreaterThan(0)
    expect(cached.descriptors).toBeDefined()
    expect(cached.descriptors.SLACK_SEND_MESSAGE).toBeDefined()
    expect(cached.descriptors.SLACK_SEND_MESSAGE.toolkit).toBe('slack')
    r.stop()
  })

  it('warm-boot from cache (no list call when cache is fresh and has new shape)', async () => {
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now(),
      aliases: { 'slack:send_message': 'SLACK_SEND_MESSAGE', 'slack:send': 'SLACK_SEND_MESSAGE', 'slack:message': 'SLACK_SEND_MESSAGE' },
      descriptors: {
        SLACK_SEND_MESSAGE: { slug: 'SLACK_SEND_MESSAGE', friendly: 'send_message', toolkit: 'slack', description: 'Send', inputParameters: {} },
      },
    }))
    const c = fakeComposio([])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(0)
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    r.stop()
  })

  it('old-shape cache (entries only) forces a refresh', async () => {
    // Pre-v0.5.3 caches had only `entries` (alias map) — no descriptors. Must regenerate.
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now(),
      entries: { 'slack:send_message': 'SLACK_SEND_MESSAGE' },
    }))
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send', description: 'd', inputParameters: { required: ['channel'] } }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(1) // refreshed because descriptors missing
    expect(r.getDescriptor('SLACK_SEND_MESSAGE')?.inputParameters?.required).toEqual(['channel'])
    r.stop()
  })

  it('listToolsForToolkit returns descriptors with input schema and stripped friendly name', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'gmail' }, slug: 'GMAIL_SEND_EMAIL', name: 'Send email', description: 'Sends an email', inputParameters: { required: ['recipient_email', 'subject', 'body'] } },
      { toolkit: { slug: 'gmail' }, slug: 'GMAIL_CREATE_DRAFT', name: 'Create draft', description: 'Drafts an email', inputParameters: { required: ['recipient_email', 'subject'] } },
      { toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send', description: 'Slack post', inputParameters: { required: ['channel', 'text'] } },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    const gmailTools = r.listToolsForToolkit('gmail')
    expect(gmailTools).toHaveLength(2)
    expect(gmailTools[0]!.friendly).toBe('create_draft')   // sorted by slug, GMAIL_CREATE_DRAFT first
    expect(gmailTools[1]!.friendly).toBe('send_email')
    expect(gmailTools[1]!.inputParameters.required).toEqual(['recipient_email', 'subject', 'body'])
    expect(r.listToolsForToolkit('slack')).toHaveLength(1)
    expect(r.listToolsForToolkit('discord')).toHaveLength(0)
    r.stop()
  })

  it('warm-boot refreshes when cache is older than 24h', async () => {
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now() - 25 * 60 * 60 * 1000,
      entries: { 'old:tool': 'OLD_TOOL' },
    }))
    const c = fakeComposio([{ toolkit: { slug: 'new' }, slug: 'NEW_TOOL', name: 'New tool' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(1)
    expect(r.resolve('new', 'tool')).toBe('NEW_TOOL')
    r.stop()
  })

  it('refresh() updates the map', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send Slack message' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    ;(c.sdk.tools.getRawComposioTools as any) = async () => [{ toolkit: { slug: 'slack' }, slug: 'SLACK_NEW_THING', name: 'New thing' }]
    await r.refresh()
    expect(r.resolve('slack', 'thing')).toBe('SLACK_NEW_THING')
    r.stop()
  })

  it('passes a toolkits FILTER per connected toolkit (SDK rejects an unfiltered fetch)', async () => {
    const calls: any[] = []
    const c = {
      sdk: { tools: { getRawComposioTools: async (opts: any) => {
        calls.push(opts)
        return [{ toolkit: { slug: opts.toolkits[0] }, slug: `${String(opts.toolkits[0]).toUpperCase()}_DO`, name: 'do' }]
      } } },
    } as any
    const r = new ComposioToolResolver({
      composio: c, userId: 'local', cachePath: join(tmp, 'cache.json'),
      toolkits: () => ['gmail', 'slack'],
    })
    await r.initialize()
    // one call per connected toolkit, each WITH a toolkits filter (never unfiltered)
    expect(calls.length).toBe(2)
    expect(calls.every((o) => Array.isArray(o.toolkits) && o.toolkits.length === 1)).toBe(true)
    expect(r.resolve('gmail', 'do')).toBe('GMAIL_DO')
    expect(r.resolve('slack', 'do')).toBe('SLACK_DO')
    r.stop()
  })

  it('with NO connected toolkits, refresh fetches nothing (no unfiltered call, no crash)', async () => {
    const calls: any[] = []
    const c = { sdk: { tools: { getRawComposioTools: async (o: any) => { calls.push(o); return [] } } } } as any
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json'), toolkits: () => [] })
    await r.initialize()
    expect(calls.length).toBe(0) // never called the SDK without a filter
    r.stop()
  })

  it('on-miss refresh is rate-limited (≤ 1 / hour)', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, slug: 'SLACK_SEND_MESSAGE', name: 'Send Slack message' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json'), now: () => 100_000 })
    await r.initialize()
    const beforeCalls = c.getCallCount()
    await r.resolveOrRefresh('discord', 'send')
    await r.resolveOrRefresh('discord', 'send')
    expect(c.getCallCount()).toBe(beforeCalls + 1)
    r.stop()
  })
})

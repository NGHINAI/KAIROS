// src/daemon/orders/v2/composioToolResolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ComposioToolResolver } from './composioToolResolver'

function fakeComposio(tools: any[], options: { onListCall?: () => void } = {}) {
  let listCalls = 0
  return {
    sdk: {
      tools: {
        list: async (_opts: any) => {
          listCalls++
          options.onListCall?.()
          return { items: tools }
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

  it('initialize populates map from tools.list', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' },
      { toolkit: { slug: 'github' }, name: 'GITHUB_CREATE_ISSUE' },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('github', 'create_issue')).toBe('GITHUB_CREATE_ISSUE')
    r.stop()
  })

  it('indexes friendly aliases — stripped toolkit prefix + suffix truncation', async () => {
    const c = fakeComposio([
      { toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' },
    ])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('slack', 'message')).toBe('SLACK_SEND_MESSAGE')
    expect(r.resolve('slack', 'send')).toBe('SLACK_SEND_MESSAGE')
    r.stop()
  })

  it('resolve returns null for unknown toolkit + tool combinations', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    expect(r.resolve('slack', 'create_channel')).toBeNull()
    expect(r.resolve('discord', 'send_message')).toBeNull()
    r.stop()
  })

  it('persists cache to disk', async () => {
    const cachePath = join(tmp, 'cache.json')
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(existsSync(cachePath)).toBe(true)
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cached.entries).toBeDefined()
    expect(Object.keys(cached.entries).length).toBeGreaterThan(0)
    r.stop()
  })

  it('warm-boot from cache (no list call when cache is fresh)', async () => {
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now(),
      entries: { 'slack:send_message': 'SLACK_SEND_MESSAGE', 'slack:send': 'SLACK_SEND_MESSAGE', 'slack:message': 'SLACK_SEND_MESSAGE' },
    }))
    const c = fakeComposio([])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(0)
    expect(r.resolve('slack', 'send_message')).toBe('SLACK_SEND_MESSAGE')
    r.stop()
  })

  it('warm-boot refreshes when cache is older than 24h', async () => {
    const cachePath = join(tmp, 'cache.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now() - 25 * 60 * 60 * 1000,
      entries: { 'old:tool': 'OLD_TOOL' },
    }))
    const c = fakeComposio([{ toolkit: { slug: 'new' }, name: 'NEW_TOOL' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath })
    await r.initialize()
    expect(c.getCallCount()).toBe(1)
    expect(r.resolve('new', 'tool')).toBe('NEW_TOOL')
    r.stop()
  })

  it('refresh() updates the map', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json') })
    await r.initialize()
    ;(c.sdk.tools.list as any) = async () => ({ items: [{ toolkit: { slug: 'slack' }, name: 'SLACK_NEW_THING' }] })
    await r.refresh()
    expect(r.resolve('slack', 'thing')).toBe('SLACK_NEW_THING')
    r.stop()
  })

  it('on-miss refresh is rate-limited (≤ 1 / hour)', async () => {
    const c = fakeComposio([{ toolkit: { slug: 'slack' }, name: 'SLACK_SEND_MESSAGE' }])
    const r = new ComposioToolResolver({ composio: c, userId: 'local', cachePath: join(tmp, 'cache.json'), now: () => 100_000 })
    await r.initialize()
    const beforeCalls = c.getCallCount()
    await r.resolveOrRefresh('discord', 'send')
    await r.resolveOrRefresh('discord', 'send')
    expect(c.getCallCount()).toBe(beforeCalls + 1)
    r.stop()
  })
})

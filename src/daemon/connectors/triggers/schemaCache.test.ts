// src/daemon/connectors/triggers/schemaCache.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TriggerSchemaCache } from './schemaCache'

function fakeComposio(types: Record<string, any>, opts: { onCall?: () => void } = {}) {
  let calls = 0
  return {
    sdk: {
      triggers: {
        get_type: async (slug: string) => {
          calls++
          opts.onCall?.()
          if (!types[slug]) throw new Error(`unknown trigger: ${slug}`)
          return types[slug]
        },
      },
    },
    getCallCount: () => calls,
  } as any
}

describe('TriggerSchemaCache', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'tsc-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('initialize bulk-loads provided slugs', async () => {
    const c = fakeComposio({ 'X': { slug: 'X', toolkit: 'gmail', config: {}, payload: {}, description: 'd' } })
    const sc = new TriggerSchemaCache({ composio: c, cachePath: join(tmp, 'c.json'), slugsToLoad: ['X'] })
    await sc.initialize()
    expect(sc.getType('X')).not.toBeNull()
  })

  it('getType returns null for unknown slug', async () => {
    const c = fakeComposio({})
    const sc = new TriggerSchemaCache({ composio: c, cachePath: join(tmp, 'c.json') })
    await sc.initialize()
    expect(sc.getType('UNKNOWN')).toBeNull()
  })

  it('on-miss refresh adds missing slug', async () => {
    const c = fakeComposio({ 'X': { slug: 'X', toolkit: 'gmail', config: {}, payload: {}, description: 'd' } })
    const sc = new TriggerSchemaCache({ composio: c, cachePath: join(tmp, 'c.json'), now: () => 100_000 })
    await sc.initialize()
    expect(await sc.resolveOrRefresh('X')).not.toBeNull()
  })

  it('on-miss refresh is rate-limited (≤ 1 / hour per slug)', async () => {
    const c = fakeComposio({})
    const sc = new TriggerSchemaCache({ composio: c, cachePath: join(tmp, 'c.json'), now: () => 100_000 })
    await sc.initialize()
    const before = c.getCallCount()
    await sc.resolveOrRefresh('MISSING')
    await sc.resolveOrRefresh('MISSING')
    expect(c.getCallCount()).toBe(before + 1)
  })

  it('warm-boot from disk cache (no API calls)', async () => {
    const cachePath = join(tmp, 'c.json')
    writeFileSync(cachePath, JSON.stringify({
      saved_at: Date.now(),
      entries: { X: { slug: 'X', toolkit: 'gmail', config_schema: {}, payload_schema: {}, description: 'd' } },
    }))
    const c = fakeComposio({})
    const sc = new TriggerSchemaCache({ composio: c, cachePath })
    await sc.initialize()
    expect(c.getCallCount()).toBe(0)
    expect(sc.getType('X')).not.toBeNull()
  })

  it('persists cache to disk', async () => {
    const cachePath = join(tmp, 'c.json')
    const c = fakeComposio({ 'X': { slug: 'X', toolkit: 'gmail', config: {}, payload: {}, description: 'd' } })
    const sc = new TriggerSchemaCache({ composio: c, cachePath, slugsToLoad: ['X'] })
    await sc.initialize()
    expect(existsSync(cachePath)).toBe(true)
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'))
    expect(cached.entries.X).toBeDefined()
  })
})

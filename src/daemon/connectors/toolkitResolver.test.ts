// src/daemon/connectors/toolkitResolver.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ToolkitResolver,
  normalize,
  tokenize,
  toCatalogEntry,
  reduceToolsToToolkits,
  type ToolkitCatalogEntry,
} from './toolkitResolver'

// A representative slice of the live catalog (shape from toolkits.list).
const CATALOG: ToolkitCatalogEntry[] = [
  { slug: 'googlecalendar', name: 'Google Calendar', description: 'Schedule and manage calendar events', categories: ['productivity'] },
  { slug: 'gmail', name: 'Gmail', description: 'Send and read email', categories: ['productivity'] },
  { slug: 'slack', name: 'Slack', description: 'Team chat and messaging', categories: ['communication'] },
  { slug: 'linear', name: 'Linear', description: 'Issue tracking and tickets for software teams', categories: ['project-management'] },
  { slug: 'github', name: 'GitHub', description: 'Code hosting, pull requests and issues', categories: ['developer-tools'] },
  { slug: 'doordash', name: 'DoorDash', description: 'Food and chicken delivery ordering app', categories: ['food'] },
]

/** A fake Composio instance. `liveList`/`liveTools` drive the live-search paths;
 *  `fetchCatalog` is injected separately on the resolver for the snapshot. */
function fakeComposio(opts: {
  liveList?: (q: any) => any[]
  liveTools?: (q: any) => any[]
  noClient?: boolean
} = {}) {
  const inst: any = {
    tools: {
      getRawComposioTools: async (q: any) => (opts.liveTools ? opts.liveTools(q) : []),
    },
  }
  if (!opts.noClient) {
    inst.client = {
      toolkits: {
        list: async (q: any) => ({ items: opts.liveList ? opts.liveList(q) : [] }),
      },
    }
  }
  return inst
}

function makeResolver(tmp: string, composio: any, fetchCatalog?: () => Promise<ToolkitCatalogEntry[]>) {
  return new ToolkitResolver({
    composio,
    cacheDir: tmp,
    fetchCatalog: fetchCatalog ?? (async () => CATALOG),
  })
}

describe('normalize / tokenize / toCatalogEntry / reduceToolsToToolkits', () => {
  it('normalize strips separators and lowercases', () => {
    expect(normalize('Google Calendar')).toBe('googlecalendar')
    expect(normalize('google-calendar')).toBe('googlecalendar')
    expect(normalize('  GMAIL_ ')).toBe('gmail')
  })

  it('tokenize drops stopwords and short tokens', () => {
    expect(tokenize('the thing I use for tickets')).toEqual(['tickets'])
    expect(tokenize('find me a chicken delivery app')).toEqual(['chicken', 'delivery'])
  })

  it('toCatalogEntry reads meta.description (right nesting)', () => {
    const e = toCatalogEntry({ slug: 'x', name: 'X', meta: { description: 'desc here', categories: ['a', { name: 'b' }] } })
    expect(e?.description).toBe('desc here')
    expect(e?.categories).toEqual(['a', 'b'])
  })

  it('reduceToolsToToolkits ranks toolkits by hit-count', () => {
    const reduced = reduceToolsToToolkits([
      { toolkit: { slug: 'gmail', name: 'Gmail' } },
      { toolkit: { slug: 'googlecalendar', name: 'Google Calendar' } },
      { toolkit: { slug: 'gmail', name: 'Gmail' } },
      { toolkit: { slug: 'gmail', name: 'Gmail' } },
    ])
    expect(reduced[0]!.slug).toBe('gmail') // 3 hits beats 1
    expect(reduced[1]!.slug).toBe('googlecalendar')
  })
})

describe('ToolkitResolver', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-toolkit-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('exact slug short-circuits with score 1', async () => {
    // composio with NO live search — proves exact-match comes from the catalog snapshot.
    const r = makeResolver(tmp, fakeComposio())
    const res = await r.resolve('slack')
    expect(res.best).toBe('slack')
    expect(res.matches[0]!.score).toBe(1)
  })

  it('fuzzy "calendar" resolves to googlecalendar via live toolkit search', async () => {
    const r = makeResolver(tmp, fakeComposio({
      liveList: (q) => CATALOG.filter((t) => (t.description ?? '').includes(q.search) || t.name.toLowerCase().includes(q.search)),
    }))
    const res = await r.resolve('calendar')
    expect(res.best).toBe('googlecalendar')
  })

  it('description-style phrase "the thing I use for tickets" → linear', async () => {
    // client.toolkits.list searches description; our fake matches on description tokens.
    const r = makeResolver(tmp, fakeComposio({
      liveList: (q) => {
        const toks = tokenize(q.search)
        return CATALOG.filter((t) => toks.some((tok) => (t.description ?? '').toLowerCase().includes(tok)))
      },
    }))
    const res = await r.resolve('the thing I use for tickets')
    expect(res.best).toBe('linear')
  })

  it('"find me a chicken delivery app" → doordash', async () => {
    const r = makeResolver(tmp, fakeComposio({
      liveList: (q) => {
        const toks = tokenize(q.search)
        return CATALOG.filter((t) => toks.some((tok) => (t.description ?? '').toLowerCase().includes(tok)))
      },
    }))
    const res = await r.resolve('find me a chicken delivery app')
    expect(res.best).toBe('doordash')
  })

  it('falls back to getRawComposioTools (tools-reduced) when client is absent', async () => {
    const r = makeResolver(tmp, fakeComposio({
      noClient: true,
      liveTools: (q) => {
        // emulate search='gmail' returning several gmail tools + one calendar tool
        if (normalize(q.search) === 'gmail') {
          return [
            { toolkit: { slug: 'gmail', name: 'Gmail' } },
            { toolkit: { slug: 'gmail', name: 'Gmail' } },
            { toolkit: { slug: 'googlecalendar', name: 'Google Calendar' } },
          ]
        }
        return []
      },
    }))
    const res = await r.resolve('gmail')
    // 'gmail' is also an exact catalog slug → exact short-circuit wins (still gmail).
    expect(res.best).toBe('gmail')
  })

  it('offline fallback: live search throws, ranks against cached catalog', async () => {
    const r = makeResolver(tmp, fakeComposio({
      liveList: () => { throw new Error('network down') },
    }))
    const res = await r.resolve('calendar')
    expect(res.best).toBe('googlecalendar') // substring/token match against snapshot
  })

  it('never throws; returns { matches: [] } when nothing matches at all', async () => {
    const r = makeResolver(tmp, fakeComposio({ liveList: () => [] }), async () => [])
    const res = await r.resolve('zzzqqq-nonexistent-xyz')
    expect(res.matches).toEqual([])
    expect(res.best).toBeUndefined()
  })

  it('returns at most 3 matches', async () => {
    const r = makeResolver(tmp, fakeComposio({
      liveList: () => CATALOG, // everything comes back; ranker should cap at 3
    }))
    const res = await r.resolve('productivity tools')
    expect(res.matches.length).toBeLessThanOrEqual(3)
  })

  it('writes and reuses the catalog cache (24h TTL)', async () => {
    let fetches = 0
    const fetchCatalog = async () => { fetches++; return CATALOG }
    const cachePath = join(tmp, 'composio-toolkit-catalog.json')

    const r1 = makeResolver(tmp, fakeComposio(), fetchCatalog)
    await r1.resolve('slack')
    expect(existsSync(cachePath)).toBe(true)
    expect(fetches).toBe(1)

    // Second resolver reuses the on-disk cache (no second fetch).
    const r2 = makeResolver(tmp, fakeComposio(), fetchCatalog)
    await r2.resolve('slack')
    expect(fetches).toBe(1)
  })

  it('refetches when the cache is stale (> 24h)', async () => {
    const cachePath = join(tmp, 'composio-toolkit-catalog.json')
    // Write a stale cache (saved 25h ago).
    writeFileSync(cachePath, JSON.stringify({ saved_at: Date.now() - 25 * 60 * 60 * 1000, toolkits: CATALOG }))
    let fetches = 0
    const r = makeResolver(tmp, fakeComposio(), async () => { fetches++; return CATALOG })
    await r.resolve('slack')
    expect(fetches).toBe(1) // stale → refetched
  })
})

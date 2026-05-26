// src/daemon/onboarding/serviceResolver.test.ts
import { describe, it, expect } from 'bun:test'
import { ServiceResolver } from './serviceResolver'
import { NpmRegistryClient } from './npmRegistryClient'
import { McpCatalogClient } from './mcpCatalogClient'
import type { McpCatalogEntry } from './mcpCatalogClient'
import type { NpmPackageCandidate } from './npmRegistryClient'

// ── mock factories ────────────────────────────────────────────────────────────

function makeCatalogEntry(overrides: Partial<McpCatalogEntry> = {}): McpCatalogEntry {
  return {
    service_name: 'github',
    display_name: 'GitHub',
    package_name: '@modelcontextprotocol/server-github',
    install_type: 'npm',
    source: 'official',
    url: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github',
    ...overrides,
  }
}

function makeNpmCandidate(overrides: Partial<NpmPackageCandidate> = {}): NpmPackageCandidate {
  return {
    name: 'mcp-server-github',
    version: '1.0.0',
    description: 'GitHub MCP server',
    npm_url: 'https://www.npmjs.com/package/mcp-server-github',
    score: 0.8,
    is_mcp_server: true,
    ...overrides,
  }
}

function mockCatalog(findResults: McpCatalogEntry[]): McpCatalogClient {
  return {
    fetchCatalog: async () => findResults,
    findByName: async (_name: string) => findResults,
  } as unknown as McpCatalogClient
}

function mockNpm(searchResults: NpmPackageCandidate[]): NpmRegistryClient {
  return {
    searchMcpServers: async (_name: string, _limit?: number) => searchResults,
    getPackageMetadata: async (_name: string) => null,
  } as unknown as NpmRegistryClient
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('ServiceResolver.resolve', () => {
  it('catalog match takes priority (confidence 1.0, source=official_mcp_catalog)', async () => {
    const resolver = new ServiceResolver({
      catalog: mockCatalog([makeCatalogEntry()]),
      npm: mockNpm([makeNpmCandidate()]),
    })

    const result = await resolver.resolve('github')

    expect(result.service_name).toBe('github')
    expect(result.candidates.length).toBeGreaterThan(0)

    const top = result.candidates[0]
    expect(top.source).toBe('official_mcp_catalog')
    expect(top.confidence).toBe(1.0)
    expect(top.package_name).toBe('@modelcontextprotocol/server-github')
  })

  it('falls through to npm when catalog returns empty', async () => {
    const resolver = new ServiceResolver({
      catalog: mockCatalog([]),
      npm: mockNpm([
        makeNpmCandidate({ name: 'mcp-server-jira', description: 'Jira MCP server', score: 0.75 }),
      ]),
    })

    const result = await resolver.resolve('jira')

    expect(result.candidates.length).toBeGreaterThan(0)
    const top = result.candidates[0]
    expect(top.source).toBe('npm')
    expect(top.package_name).toBe('mcp-server-jira')
    expect(top.confidence).toBe(0.75)
  })

  it('dedupes the same package appearing in both sources', async () => {
    // Catalog has the official entry; npm also returns the same package
    const resolver = new ServiceResolver({
      catalog: mockCatalog([
        makeCatalogEntry({ package_name: '@modelcontextprotocol/server-github' }),
      ]),
      npm: mockNpm([
        makeNpmCandidate({ name: '@modelcontextprotocol/server-github', score: 0.9 }),
        makeNpmCandidate({ name: 'mcp-github-unofficial', score: 0.5 }),
      ]),
    })

    const result = await resolver.resolve('github')

    const names = result.candidates.map(c => c.package_name)
    const officialCount = names.filter(n => n === '@modelcontextprotocol/server-github').length
    expect(officialCount).toBe(1) // deduped to exactly one
  })

  it('returns empty candidates + helpful notes when both sources return nothing', async () => {
    const resolver = new ServiceResolver({
      catalog: mockCatalog([]),
      npm: mockNpm([]),
    })

    const result = await resolver.resolve('obscure-nonexistent-service')

    expect(result.candidates.length).toBe(0)
    expect(result.notes).toBeDefined()
    expect(result.notes).toContain('no MCP server found')
    expect(result.notes).toContain('obscure-nonexistent-service')
  })

  it('top 5 limit enforced when many candidates exist', async () => {
    const manyNpm: NpmPackageCandidate[] = Array.from({ length: 10 }, (_, i) =>
      makeNpmCandidate({
        name: `mcp-server-test-${i}`,
        description: `MCP server test ${i}`,
        score: 1 - i * 0.05,
      })
    )

    const resolver = new ServiceResolver({
      catalog: mockCatalog([]),
      npm: mockNpm(manyNpm),
    })

    const result = await resolver.resolve('test')
    expect(result.candidates.length).toBeLessThanOrEqual(5)
  })

  it('includes resolved_at timestamp', async () => {
    const before = Date.now()
    const resolver = new ServiceResolver({
      catalog: mockCatalog([]),
      npm: mockNpm([]),
    })

    const result = await resolver.resolve('anything')
    const after = Date.now()

    expect(result.resolved_at).toBeGreaterThanOrEqual(before)
    expect(result.resolved_at).toBeLessThanOrEqual(after)
  })
})

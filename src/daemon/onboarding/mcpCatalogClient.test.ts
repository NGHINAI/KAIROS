// src/daemon/onboarding/mcpCatalogClient.test.ts
import { describe, it, expect } from 'bun:test'
import { McpCatalogClient } from './mcpCatalogClient'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'

function tmpCacheFile(): string {
  return join(tmpdir(), `mcp-catalog-test-${randomBytes(6).toString('hex')}.json`)
}

// ── sample README fixture ─────────────────────────────────────────────────────

const SAMPLE_README = `
# MCP Servers

## Reference Servers

These are official servers:

| Server | Description | Package |
|--------|-------------|---------|
| [GitHub](https://github.com/modelcontextprotocol/servers/tree/main/src/github) | GitHub API integration | \`@modelcontextprotocol/server-github\` |
| [Filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) | Local file system access | \`@modelcontextprotocol/server-filesystem\` |
| [PostgreSQL](https://github.com/modelcontextprotocol/servers/tree/main/src/postgres) | PostgreSQL database | \`@modelcontextprotocol/server-postgres\` |

## Community Servers

| Server | Description | Package |
|--------|-------------|---------|
| [Jira](https://github.com/user/jira-mcp) | Jira issue tracker | \`mcp-server-jira\` |
| [Discord](https://github.com/user/discord-mcp) | Discord messaging | \`mcp-server-discord\` |
`

function makeReadmeResponse(text = SAMPLE_README, status = 200) {
  return new Response(text, {
    status,
    headers: { 'Content-Type': 'text/plain' },
  })
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('McpCatalogClient.fetchCatalog', () => {
  it('parses a mocked README into entries', async () => {
    const mockFetch = async (_url: string) => makeReadmeResponse()

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 0, // disable cache so we always fetch
      cacheFile: tmpCacheFile(),
    })

    const entries = await client.fetchCatalog()

    expect(entries.length).toBeGreaterThan(0)

    const github = entries.find(e => e.service_name === 'github')
    expect(github).toBeDefined()
    expect(github!.package_name).toBe('@modelcontextprotocol/server-github')
    expect(github!.source).toBe('official')
    expect(github!.install_type).toBe('npm')
  })

  it('caches result within TTL (second call skips HTTP)', async () => {
    let fetchCount = 0
    const mockFetch = async (_url: string) => {
      fetchCount++
      return makeReadmeResponse()
    }

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 60_000, // 1 minute TTL
      cacheFile: tmpCacheFile(),
    })

    // Force fresh start by resetting internal mem cache (ttl not expired)
    await client.fetchCatalog()
    await client.fetchCatalog()
    await client.fetchCatalog()

    // Should have fetched only once
    expect(fetchCount).toBe(1)
  })

  it('cache expires after TTL (forces re-fetch)', async () => {
    let fetchCount = 0
    const mockFetch = async (_url: string) => {
      fetchCount++
      return makeReadmeResponse()
    }

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 1, // 1ms TTL — expires almost immediately
      cacheFile: tmpCacheFile(),
    })

    await client.fetchCatalog()
    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 10))
    await client.fetchCatalog()

    // Should have fetched twice
    expect(fetchCount).toBe(2)
  })

  it('returns [] gracefully on HTTP error', async () => {
    const mockFetch = async (_url: string) => {
      throw new Error('Network unreachable')
    }

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 0, // no cache, so no stale fallback
      cacheFile: tmpCacheFile(), // isolated file
    })

    const entries = await client.fetchCatalog()
    expect(Array.isArray(entries)).toBe(true)
    expect(entries.length).toBe(0)
  })

  it('falls back to stale cache when network fails', async () => {
    let callCount = 0
    const mockFetch = async (_url: string) => {
      callCount++
      if (callCount === 1) {
        return makeReadmeResponse() // first call succeeds
      }
      throw new Error('Network unreachable') // subsequent calls fail
    }

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 1, // 1ms TTL so cache expires quickly
      cacheFile: tmpCacheFile(),
    })

    // Populate the cache
    const first = await client.fetchCatalog()
    expect(first.length).toBeGreaterThan(0)

    // Wait for TTL to expire
    await new Promise(r => setTimeout(r, 10))

    // Second fetch should fail network but return stale cache
    const second = await client.fetchCatalog()
    expect(second.length).toBeGreaterThan(0) // stale data still returned
  })
})

describe('McpCatalogClient.findByName', () => {
  it('does case-insensitive substring match', async () => {
    const mockFetch = async (_url: string) => makeReadmeResponse()

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 60_000,
      cacheFile: tmpCacheFile(),
    })

    const results = await client.findByName('GitHub')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].service_name).toBe('github')

    const results2 = await client.findByName('GITHUB')
    expect(results2.length).toBeGreaterThan(0)
  })

  it('returns community entries correctly', async () => {
    const mockFetch = async (_url: string) => makeReadmeResponse()

    const client = new McpCatalogClient({
      fetch: mockFetch as any,
      cacheTtlMs: 60_000,
      cacheFile: tmpCacheFile(),
    })

    const results = await client.findByName('jira')
    expect(results.length).toBeGreaterThan(0)
    // jira is in community section
    expect(results[0].source).toBe('community')
    expect(results[0].package_name).toBe('mcp-server-jira')
  })
})

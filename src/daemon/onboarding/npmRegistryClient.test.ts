// src/daemon/onboarding/npmRegistryClient.test.ts
import { describe, it, expect } from 'bun:test'
import { NpmRegistryClient } from './npmRegistryClient'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSearchResponse(objects: any[]) {
  return new Response(JSON.stringify({ objects }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makePackageResponse(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeSearchObject(name: string, description: string, score = 0.8) {
  return {
    package: {
      name,
      version: '1.0.0',
      description,
      links: { npm: `https://www.npmjs.com/package/${name}` },
    },
    score: { final: score },
  }
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('NpmRegistryClient.searchMcpServers', () => {
  it('returns ranked candidates from registry JSON', async () => {
    const mockFetch = async (_url: string) => {
      return makeSearchResponse([
        makeSearchObject('@modelcontextprotocol/server-github', 'GitHub MCP server', 0.9),
        makeSearchObject('mcp-server-github', 'An mcp-server for GitHub', 0.7),
      ])
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const results = await client.searchMcpServers('github')

    expect(results.length).toBeGreaterThan(0)
    // Higher score should be first
    expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score)
    expect(results[0].name).toBe('@modelcontextprotocol/server-github')
  })

  it('filters to is_mcp_server only (name/description heuristic)', async () => {
    const mockFetch = async (_url: string) => {
      return makeSearchResponse([
        makeSearchObject('github-api-wrapper', 'A plain GitHub API wrapper', 0.9),
        makeSearchObject('mcp-server-github', 'An MCP server for GitHub', 0.7),
        makeSearchObject('github-lint', 'Linting tool, no MCP', 0.8),
      ])
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const results = await client.searchMcpServers('github')

    expect(results.every(r => r.is_mcp_server)).toBe(true)
    expect(results.find(r => r.name === 'github-api-wrapper')).toBeUndefined()
    expect(results.find(r => r.name === 'mcp-server-github')).toBeDefined()
  })

  it('retries with alternate query if first returns empty', async () => {
    let callCount = 0
    const mockFetch = async (url: string) => {
      callCount++
      const urlStr = url.toString()
      if (urlStr.includes('discord+mcp') || urlStr.includes('discord%20mcp')) {
        // First query returns empty
        return makeSearchResponse([])
      }
      // Fallback query returns results
      return makeSearchResponse([
        makeSearchObject('mcp-server-discord', 'Discord MCP server', 0.8),
      ])
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const results = await client.searchMcpServers('discord')

    // Should have made at least 2 calls (primary + fallback)
    expect(callCount).toBeGreaterThanOrEqual(2)
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].name).toBe('mcp-server-discord')
  })

  it('dedupes across retries (same package from both queries)', async () => {
    const mockFetch = async (_url: string) => {
      // Both queries return the same package
      return makeSearchResponse([
        makeSearchObject('@modelcontextprotocol/server-jira', 'Jira MCP server', 0.85),
      ])
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const results = await client.searchMcpServers('jira')

    const names = results.map(r => r.name)
    const unique = new Set(names)
    expect(names.length).toBe(unique.size) // no duplicates
  })

  it('respects limit parameter', async () => {
    const mockFetch = async (_url: string) => {
      return makeSearchResponse([
        makeSearchObject('mcp-server-a', 'MCP server A', 0.9),
        makeSearchObject('mcp-server-b', 'Model Context Protocol B', 0.8),
        makeSearchObject('mcp-server-c', 'MCP server C', 0.7),
        makeSearchObject('mcp-server-d', 'mcp-server D', 0.6),
        makeSearchObject('mcp-server-e', 'MCP server E', 0.5),
        makeSearchObject('mcp-server-f', 'MCP server F', 0.4),
      ])
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const results = await client.searchMcpServers('anything', 3)
    expect(results.length).toBeLessThanOrEqual(3)
  })
})

describe('NpmRegistryClient.getPackageMetadata', () => {
  it('returns metadata for an existing package', async () => {
    const mockFetch = async (_url: string) => {
      return makePackageResponse({
        name: '@modelcontextprotocol/server-github',
        version: '2.1.0',
        description: 'MCP server for GitHub',
      })
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const result = await client.getPackageMetadata('@modelcontextprotocol/server-github')

    expect(result).not.toBeNull()
    expect(result!.name).toBe('@modelcontextprotocol/server-github')
    expect(result!.version).toBe('2.1.0')
    expect(result!.description).toBe('MCP server for GitHub')
  })

  it('returns null on 404', async () => {
    const mockFetch = async (_url: string) => {
      return makePackageResponse({ error: 'Not found' }, 404)
    }

    const client = new NpmRegistryClient({ fetch: mockFetch as any })
    const result = await client.getPackageMetadata('@fake/nonexistent-package')
    expect(result).toBeNull()
  })
})

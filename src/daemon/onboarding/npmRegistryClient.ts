// src/daemon/onboarding/npmRegistryClient.ts
// Queries the public npm registry search API to find MCP server packages.
// Pure HTTP, no auth required. All errors are caught and logged gracefully.

export type NpmPackageCandidate = {
  name: string
  version: string
  description: string
  npm_url: string
  score: number          // 0..1 from npm's own scoring
  is_mcp_server: boolean // heuristic: name or description mentions MCP
}

export type NpmRegistryClientOptions = {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number // default 5000
}

const REGISTRY_SEARCH = 'https://registry.npmjs.org/-/v1/search'
const REGISTRY_PKG = 'https://registry.npmjs.org'

// Heuristic: does this package look like an MCP server?
function isMcpServer(name: string, description: string): boolean {
  const n = name.toLowerCase()
  const d = description.toLowerCase()
  return (
    n.includes('mcp') ||
    n.includes('modelcontextprotocol') ||
    d.includes('mcp server') ||
    d.includes('model context protocol') ||
    d.includes('mcp-server')
  )
}

function buildUrl(base: string, params: Record<string, string>): string {
  const u = new URL(base)
  for (const [k, v] of Object.entries(params)) {
    u.searchParams.set(k, v)
  }
  return u.toString()
}

export class NpmRegistryClient {
  private fetchFn: typeof globalThis.fetch
  private timeoutMs: number

  constructor(opts?: NpmRegistryClientOptions) {
    this.fetchFn = opts?.fetch ?? globalThis.fetch
    this.timeoutMs = opts?.timeoutMs ?? 5000
  }

  private async fetchWithTimeout(url: string): Promise<Response> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
    try {
      return await this.fetchFn(url, { signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  private async searchQuery(query: string, size: number): Promise<NpmPackageCandidate[]> {
    const url = buildUrl(REGISTRY_SEARCH, { text: query, size: String(size) })
    let res: Response
    try {
      res = await this.fetchWithTimeout(url)
    } catch (err) {
      console.warn(`[NpmRegistryClient] HTTP error for query "${query}":`, err instanceof Error ? err.message : err)
      return []
    }
    if (!res.ok) {
      console.warn(`[NpmRegistryClient] Non-OK response ${res.status} for query "${query}"`)
      return []
    }
    let body: any
    try {
      body = await res.json()
    } catch {
      console.warn(`[NpmRegistryClient] Failed to parse JSON for query "${query}"`)
      return []
    }
    const objects: any[] = Array.isArray(body?.objects) ? body.objects : []
    return objects.map((obj): NpmPackageCandidate => {
      const pkg = obj.package ?? {}
      const name: string = pkg.name ?? ''
      const description: string = pkg.description ?? ''

      // npm's score.final is a raw relevance score (can be 200+), NOT 0..1.
      // Normalize using the 0..1 detail sub-scores (avg of quality, popularity, maintenance).
      // Fall back to clamping final/300 if detail sub-scores are unavailable.
      let score = 0
      const detail = obj.score?.detail
      if (detail && typeof detail.quality === 'number') {
        const q = detail.quality ?? 0
        const p = detail.popularity ?? 0
        const m = detail.maintenance ?? 0
        // Weighted: quality 40%, popularity 30%, maintenance 30%
        score = Math.min(1, q * 0.4 + p * 0.3 + m * 0.3)
      } else if (typeof obj.score?.final === 'number') {
        // Fallback: cap at 1.0 by dividing by a generous max
        score = Math.min(1, obj.score.final / 300)
      }

      return {
        name,
        version: pkg.version ?? '0.0.0',
        description,
        npm_url: pkg.links?.npm ?? `https://www.npmjs.com/package/${encodeURIComponent(name)}`,
        score,
        is_mcp_server: isMcpServer(name, description),
      }
    })
  }

  /**
   * Returns up to `limit` candidates ranked by npm's score, filtered to those
   * that look like MCP servers.
   * Queries `<serviceName>+mcp` first; if 0 results, retries with
   * `mcp-server+<serviceName>`. Combines + dedupes.
   */
  async searchMcpServers(serviceName: string, limit = 5): Promise<NpmPackageCandidate[]> {
    const fetchSize = limit * 3 // over-fetch to ensure enough after filtering

    const primary = await this.searchQuery(`${serviceName} mcp`, fetchSize)
    const primaryMcp = primary.filter(p => p.is_mcp_server)

    let combined = [...primaryMcp]

    if (primaryMcp.length === 0) {
      const fallback = await this.searchQuery(`mcp-server ${serviceName}`, fetchSize)
      combined = fallback.filter(p => p.is_mcp_server)
    } else {
      // Also run fallback and merge to widen coverage
      const fallback = await this.searchQuery(`mcp-server ${serviceName}`, fetchSize)
      const fallbackMcp = fallback.filter(p => p.is_mcp_server)
      combined = [...primaryMcp, ...fallbackMcp]
    }

    // Dedupe by package name (keep highest score)
    const seen = new Map<string, NpmPackageCandidate>()
    for (const c of combined) {
      const existing = seen.get(c.name)
      if (!existing || c.score > existing.score) {
        seen.set(c.name, c)
      }
    }

    return [...seen.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * Direct existence check. Returns null if the package doesn't exist (404).
   */
  async getPackageMetadata(packageName: string): Promise<{ name: string; version: string; description: string } | null> {
    const url = `${REGISTRY_PKG}/${encodeURIComponent(packageName).replace('%40', '@')}/latest`
    let res: Response
    try {
      res = await this.fetchWithTimeout(url)
    } catch (err) {
      console.warn(`[NpmRegistryClient] HTTP error for package "${packageName}":`, err instanceof Error ? err.message : err)
      return null
    }
    if (res.status === 404) return null
    if (!res.ok) {
      console.warn(`[NpmRegistryClient] Non-OK response ${res.status} for package "${packageName}"`)
      return null
    }
    let body: any
    try {
      body = await res.json()
    } catch {
      console.warn(`[NpmRegistryClient] Failed to parse JSON for package "${packageName}"`)
      return null
    }
    return {
      name: body.name ?? packageName,
      version: body.version ?? '0.0.0',
      description: body.description ?? '',
    }
  }
}

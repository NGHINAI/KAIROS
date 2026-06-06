// src/daemon/onboarding/mcpCatalogClient.ts
// Fetches and caches the official MCP servers catalog from GitHub.
// Defensive parsing: returns [] on any failure rather than throwing.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type McpCatalogEntry = {
  service_name: string   // normalized lowercase (e.g. 'github', 'filesystem')
  display_name: string
  package_name: string | null   // npm package or null if non-npm
  install_type: 'npm' | 'docker' | 'go' | 'python' | 'unknown'
  source: 'official' | 'community'
  url?: string
}

export type McpCatalogClientOptions = {
  fetch?: typeof globalThis.fetch
  timeoutMs?: number   // default 5000
  cacheTtlMs?: number  // default 1 hour
  cacheFile?: string   // override cache path (useful for tests to avoid cross-test pollution)
}

const CATALOG_URL = 'https://raw.githubusercontent.com/modelcontextprotocol/servers/main/README.md'
const CACHE_DIR = join(homedir(), '.kairos', 'cache')
const CACHE_FILE = join(CACHE_DIR, 'mcp-catalog.json')
const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

type CacheFile = {
  timestamp: number
  entries: McpCatalogEntry[]
}

// Determine install_type from package/description hints
function detectInstallType(pkg: string | null, context: string): McpCatalogEntry['install_type'] {
  if (pkg && (pkg.startsWith('@') || pkg.match(/^[a-z0-9-]+$/))) return 'npm'
  const c = context.toLowerCase()
  if (c.includes('docker')) return 'docker'
  if (c.includes('go install') || c.includes('golang')) return 'go'
  if (c.includes('pip install') || c.includes('python')) return 'python'
  return 'unknown'
}

/**
 * Parse the MCP servers README markdown into catalog entries.
 * Handles both the legacy table format and the current bullet-list format.
 * Very defensive — returns whatever could be parsed, never throws.
 *
 * Current README format (as of 2025):
 *   - **[Name](url)** - description
 * with npm packages embedded in JSON code blocks:
 *   "args": ["-y", "@modelcontextprotocol/server-X"]
 *
 * Legacy format had markdown tables — still supported for robustness.
 */
function parseReadme(markdown: string): McpCatalogEntry[] {
  const entries: McpCatalogEntry[] = []

  try {
    // --- Pass 1: Build a map of service_name → package from npx/args patterns ---
    // Matches: npx -y @modelcontextprotocol/server-X or "args": ["-y", "@scope/pkg"]
    const pkgMap = new Map<string, string>()

    const argsPat = /"args"\s*:\s*\[(?:[^[\]]*?"-y"\s*,\s*)"(@[a-z0-9@/.-]+)"/g
    for (const m of markdown.matchAll(argsPat)) {
      const pkg = m[1]!
      // Derive a service slug from the package name
      const slug = pkg
        .replace('@modelcontextprotocol/server-', '')
        .replace(/^@[^/]+\//, '')
        .replace(/^mcp-server-/, '')
        .toLowerCase()
      pkgMap.set(slug, pkg)
    }

    // Also match standalone: npx -y @modelcontextprotocol/server-X
    const npxPat = /npx\s+(?:-y\s+)?(@modelcontextprotocol\/server-[a-z0-9-]+)/g
    for (const m of markdown.matchAll(npxPat)) {
      const pkg = m[1]!
      const slug = pkg.replace('@modelcontextprotocol/server-', '').toLowerCase()
      pkgMap.set(slug, pkg)
    }

    // --- Pass 2: Parse entries from section lines ---
    let currentSource: 'official' | 'community' = 'official'
    // Track whether we're in the "archived" subsection (still official but archived)
    let inArchived = false

    const lines = markdown.split('\n')

    for (const line of lines) {
      // Detect section/subsection headers
      const headingMatch = line.match(/^(#+)\s+(.+)/)
      if (headingMatch) {
        const level = headingMatch[1]!.length
        const heading = headingMatch[2]!.toLowerCase().replace(/[^\w\s]/g, '')
        if (heading.includes('community')) {
          currentSource = 'community'
          inArchived = false
        } else if (heading.includes('reference') || heading.includes('official')) {
          currentSource = 'official'
          inArchived = false
        } else if (heading.includes('archived') && level >= 3) {
          // Subsection: still "official" but archived servers
          inArchived = true
        } else if (level <= 2 && !heading.includes('archived')) {
          // Top-level section that's not community/official — reset to official
          // (handles "Frameworks", "Resources", etc. — we skip those entries anyway)
        }
        continue
      }

      // Pattern A: Bullet-list format (current README as of 2025)
      // - **[Name](url)** - description
      // Also handles: * **[Name](url)** (description)
      const bulletMatch = line.match(/^[-*]\s+\*\*\[([^\]]+)\]\(([^)]*)\)\*\*/)
      if (bulletMatch) {
        const displayName = bulletMatch[1]!.trim()
        const url = bulletMatch[2]!.trim()

        // Try to look up package from our pkgMap using the service name slug
        const slug = displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        // Also try common variations
        const slugVariants = [slug, slug.replace(/-/g, ''), displayName.toLowerCase()]
        let packageName: string | null = null

        for (const v of slugVariants) {
          if (pkgMap.has(v)) {
            packageName = pkgMap.get(v)!
            break
          }
        }

        // Also look for npm package patterns in the rest of the line
        if (!packageName) {
          const scopedPkg = line.match(/@modelcontextprotocol\/server-[a-z0-9-]+/)
          if (scopedPkg) packageName = scopedPkg[0]
        }

        // Look for npmjs.com links in the line
        if (!packageName) {
          const npmLink = line.match(/npmjs\.com\/package\/([^)\s"]+)/)
          if (npmLink) packageName = decodeURIComponent(npmLink[1]!)
        }

        const install_type = detectInstallType(packageName, line)

        entries.push({
          service_name: slug || displayName.toLowerCase(),
          display_name: displayName,
          package_name: packageName,
          install_type,
          source: currentSource,
          url: url || undefined,
        })
        continue
      }

      // Pattern B: Legacy markdown table rows
      // | [Name](url) | description | ... |
      const tableRowMatch = line.match(/^\|\s*\[([^\]]+)\]\(([^)]*)\)\s*\|(.+)/)
      if (tableRowMatch) {
        const displayName = tableRowMatch[1]!.trim()
        const url = tableRowMatch[2]!.trim()
        const rest = tableRowMatch[3]!

        let packageName: string | null = null

        const backtickPkg = rest.match(/`(@[a-z0-9@/-]+|[a-z0-9-]+\/[a-z0-9-]+|mcp-server-[a-z0-9-]+)`/)
        if (backtickPkg) packageName = backtickPkg[1]!

        const scopedPkg = rest.match(/@modelcontextprotocol\/server-[a-z0-9-]+/)
        if (scopedPkg && !packageName) packageName = scopedPkg[0]

        if (!packageName && url.includes('npmjs.com/package/')) {
          const urlPkg = url.match(/npmjs\.com\/package\/([^)"\s]+)/)
          if (urlPkg) packageName = decodeURIComponent(urlPkg[1]!)
        }

        const slug = displayName.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')
        const install_type = detectInstallType(packageName, rest)

        entries.push({
          service_name: slug || displayName.toLowerCase(),
          display_name: displayName,
          package_name: packageName,
          install_type,
          source: currentSource,
          url: url || undefined,
        })
      }
    }
  } catch (err) {
    console.warn('[McpCatalogClient] Parse error (returning partial results):', err instanceof Error ? err.message : err)
  }

  // Dedupe by service_name (keep first occurrence — typically the most prominent section)
  const seen = new Set<string>()
  return entries.filter(e => {
    if (seen.has(e.service_name)) return false
    seen.add(e.service_name)
    return true
  })
}


export class McpCatalogClient {
  private fetchFn: typeof globalThis.fetch
  private timeoutMs: number
  private cacheTtlMs: number
  private cacheFile: string

  // In-memory cache for the current process session
  private memCache: { timestamp: number; entries: McpCatalogEntry[] } | null = null

  constructor(opts?: McpCatalogClientOptions) {
    this.fetchFn = opts?.fetch ?? globalThis.fetch
    this.timeoutMs = opts?.timeoutMs ?? 5000
    this.cacheTtlMs = opts?.cacheTtlMs ?? DEFAULT_TTL_MS
    this.cacheFile = opts?.cacheFile ?? CACHE_FILE
  }

  private readCache(): CacheFile | null {
    // cacheTtlMs=0 means "never use cache"
    if (this.cacheTtlMs === 0) return null
    try {
      const raw = readFileSync(this.cacheFile, 'utf-8')
      return JSON.parse(raw) as CacheFile
    } catch {
      return null
    }
  }

  private writeCache(entries: McpCatalogEntry[]): void {
    // cacheTtlMs=0 means "never write cache"
    if (this.cacheTtlMs === 0) return
    try {
      const dir = this.cacheFile.substring(0, this.cacheFile.lastIndexOf('/'))
      mkdirSync(dir, { recursive: true })
      const data: CacheFile = { timestamp: Date.now(), entries }
      writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), 'utf-8')
    } catch (err) {
      console.warn('[McpCatalogClient] Failed to write cache:', err instanceof Error ? err.message : err)
    }
  }

  /** Fetches the catalog (cached for cacheTtlMs). Falls back to stale cache on error. */
  async fetchCatalog(): Promise<McpCatalogEntry[]> {
    const now = Date.now()

    // cacheTtlMs=0 means always bypass cache
    if (this.cacheTtlMs > 0) {
      // Check in-memory cache first
      if (this.memCache && now - this.memCache.timestamp < this.cacheTtlMs) {
        return this.memCache.entries
      }

      // Check disk cache
      const diskCache = this.readCache()
      if (diskCache && now - diskCache.timestamp < this.cacheTtlMs) {
        this.memCache = diskCache
        return diskCache.entries
      }
    }

    // Read stale cache now (for use as fallback on network error)
    const staleCache = this.cacheTtlMs > 0 ? this.readCache() : null

    // Fetch from network
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs)
      let res: Response
      try {
        res = await this.fetchFn(CATALOG_URL, { signal: ctrl.signal })
      } finally {
        clearTimeout(timer)
      }

      if (!res.ok) {
        console.warn(`[McpCatalogClient] HTTP ${res.status} fetching catalog`)
        // Fall back to stale cache
        if (staleCache) {
          console.warn('[McpCatalogClient] Using stale cache as fallback')
          return staleCache.entries
        }
        return []
      }

      const text = await res.text()
      const entries = parseReadme(text)

      // Update caches (skip if cacheTtlMs=0)
      if (this.cacheTtlMs > 0) {
        this.memCache = { timestamp: now, entries }
      }
      this.writeCache(entries)

      return entries
    } catch (err) {
      console.warn('[McpCatalogClient] Network error fetching catalog:', err instanceof Error ? err.message : err)
      // Fall back to stale cache
      if (staleCache) {
        console.warn('[McpCatalogClient] Using stale cache as fallback')
        return staleCache.entries
      }
      return []
    }
  }

  /**
   * Fuzzy-match a service name against the catalog.
   * Returns matches sorted by relevance (exact > prefix > substring).
   */
  async findByName(serviceName: string): Promise<McpCatalogEntry[]> {
    const entries = await this.fetchCatalog()
    const query = serviceName.toLowerCase().trim()

    const scored: Array<{ entry: McpCatalogEntry; score: number }> = []

    for (const entry of entries) {
      const sn = entry.service_name.toLowerCase()
      const dn = entry.display_name.toLowerCase()
      const pkg = (entry.package_name ?? '').toLowerCase()

      let score = 0

      // Exact match on service_name
      if (sn === query) { score = 100; }
      // Exact match on display_name
      else if (dn === query) { score = 95; }
      // Package name exact
      else if (pkg === query || pkg.endsWith(`/${query}`) || pkg.endsWith(`-${query}`)) { score = 90; }
      // Prefix match
      else if (sn.startsWith(query) || dn.startsWith(query)) { score = 70; }
      // Substring match
      else if (sn.includes(query) || dn.includes(query) || pkg.includes(query)) { score = 40; }

      if (score > 0) {
        scored.push({ entry, score })
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .map(s => s.entry)
  }
}

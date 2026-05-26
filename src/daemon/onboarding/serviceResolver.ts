// src/daemon/onboarding/serviceResolver.ts
// Orchestrates NpmRegistryClient + McpCatalogClient to ground the LLM's package
// choices before SetupSkillGenerator runs. v2 will add WebSearchClient fallback.

import type { NpmRegistryClient } from './npmRegistryClient'
import type { McpCatalogClient } from './mcpCatalogClient'

export type ResolvedCandidate = {
  source: 'npm' | 'official_mcp_catalog' | 'web_search'
  package_name: string | null    // npm package name, null if non-npm install
  install_type: 'npm' | 'smithery' | 'docker' | 'go' | 'python' | 'unknown'
  description: string
  url?: string
  confidence: number             // 0..1
}

export type ResolvedService = {
  service_name: string
  candidates: ResolvedCandidate[]
  resolved_at: number
  notes?: string
}

export type ServiceResolverDeps = {
  npm: NpmRegistryClient
  catalog: McpCatalogClient
  // webSearch?: WebSearchClient  // v2: stub for future wiring — not used in v1
}

const MAX_CANDIDATES = 5

export class ServiceResolver {
  constructor(private deps: ServiceResolverDeps) {}

  async resolve(serviceName: string): Promise<ResolvedService> {
    const name = serviceName.trim().toLowerCase()

    // --- Step 1: Official catalog (highest confidence) ---
    let catalogCandidates: ResolvedCandidate[] = []
    try {
      const catalogMatches = await this.deps.catalog.findByName(name)
      for (const entry of catalogMatches) {
        // Only include official entries in step 1; community entries are lower priority
        if (entry.source !== 'official') continue
        catalogCandidates.push({
          source: 'official_mcp_catalog',
          package_name: entry.package_name,
          install_type: this.mapInstallType(entry.install_type),
          description: entry.display_name,
          url: entry.url,
          confidence: 1.0,
        })
      }
      // Also add community catalog entries at lower confidence
      for (const entry of catalogMatches) {
        if (entry.source !== 'community') continue
        catalogCandidates.push({
          source: 'official_mcp_catalog',
          package_name: entry.package_name,
          install_type: this.mapInstallType(entry.install_type),
          description: entry.display_name,
          url: entry.url,
          confidence: 0.8,
        })
      }
    } catch (err) {
      console.warn('[ServiceResolver] Catalog lookup failed:', err instanceof Error ? err.message : err)
    }

    // --- Step 2: npm registry ---
    let npmCandidates: ResolvedCandidate[] = []
    try {
      const npmResults = await this.deps.npm.searchMcpServers(name, MAX_CANDIDATES)
      for (const pkg of npmResults) {
        npmCandidates.push({
          source: 'npm',
          package_name: pkg.name,
          install_type: 'npm',
          description: pkg.description,
          url: pkg.npm_url,
          confidence: pkg.score,
        })
      }
    } catch (err) {
      console.warn('[ServiceResolver] npm lookup failed:', err instanceof Error ? err.message : err)
    }

    // --- Step 3: Dedupe — catalog wins over npm for same package ---
    const catalogPackages = new Set(
      catalogCandidates.map(c => c.package_name).filter(Boolean)
    )

    const filteredNpm = npmCandidates.filter(c => !catalogPackages.has(c.package_name))

    // Merge: catalog entries first (by confidence desc), then npm
    const merged = [...catalogCandidates, ...filteredNpm]

    // --- Step 4: Sort by confidence desc, then source preference ---
    const sourceOrder: Record<ResolvedCandidate['source'], number> = {
      official_mcp_catalog: 0,
      npm: 1,
      web_search: 2,
    }
    merged.sort((a, b) => {
      if (b.confidence !== a.confidence) return b.confidence - a.confidence
      return sourceOrder[a.source] - sourceOrder[b.source]
    })

    // --- Step 5: Limit to top 5 ---
    const candidates = merged.slice(0, MAX_CANDIDATES)

    // --- Step 6: Empty case ---
    let notes: string | undefined
    if (candidates.length === 0) {
      notes = `no MCP server found for "${serviceName}"; consider trying a different name like "${serviceName}-mcp" or search the catalog at modelcontextprotocol.io/servers`
    }

    return {
      service_name: serviceName,
      candidates,
      resolved_at: Date.now(),
      notes,
    }
  }

  private mapInstallType(
    t: 'npm' | 'docker' | 'go' | 'python' | 'unknown'
  ): ResolvedCandidate['install_type'] {
    // install_type on ResolvedCandidate adds 'smithery' over McpCatalogEntry
    // Catalog entries never come back as smithery; that's set by higher-level logic
    return t as ResolvedCandidate['install_type']
  }
}

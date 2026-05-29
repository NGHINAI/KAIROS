// src/daemon/orders/v2/composioToolResolver.ts
// Maps friendly {toolkit, name} → exact Composio toolName via tools.list catalog.
// Caches to ~/.kairos/composio-tools-cache.json (warm-boot < 50ms). Daily refresh.
// On-miss refresh is rate-limited to once per hour.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const ONMISS_REFRESH_INTERVAL_MS = 60 * 60 * 1000

export type ComposioToolResolverDeps = {
  composio: { sdk: { tools: { list: (opts: any) => Promise<{ items: any[] }> } } }
  userId: string
  cachePath?: string
  now?: () => number
}

type CacheFile = {
  saved_at: number
  entries: Record<string, string>
}

export class ComposioToolResolver {
  private map = new Map<string, string>()
  private dailyTimer: ReturnType<typeof setInterval> | null = null
  private cachePath: string
  private now: () => number
  private lastOnMissRefreshAt = -ONMISS_REFRESH_INTERVAL_MS

  constructor(private deps: ComposioToolResolverDeps) {
    this.cachePath = deps.cachePath ?? join(homedir(), '.kairos', 'composio-tools-cache.json')
    this.now = deps.now ?? Date.now
  }

  async initialize(): Promise<void> {
    if (this.loadCache()) {
      this.startDailyTimer()
      return
    }
    await this.refresh()
    this.startDailyTimer()
  }

  resolve(toolkit: string, friendlyName: string): string | null {
    const key = `${toolkit.toLowerCase()}:${friendlyName.toLowerCase()}`
    return this.map.get(key) ?? null
  }

  async resolveOrRefresh(toolkit: string, friendlyName: string): Promise<string | null> {
    const hit = this.resolve(toolkit, friendlyName)
    if (hit) return hit
    const now = this.now()
    if (now - this.lastOnMissRefreshAt >= ONMISS_REFRESH_INTERVAL_MS) {
      this.lastOnMissRefreshAt = now
      try { await this.refresh() } catch { /* swallow */ }
      return this.resolve(toolkit, friendlyName)
    }
    return null
  }

  async refresh(): Promise<void> {
    const result = await this.deps.composio.sdk.tools.list({ limit: 500 })
    const items = result.items ?? []
    const next = new Map<string, string>()
    for (const t of items) {
      const slug = (t.toolkit?.slug ?? t.toolkit_slug ?? '').toLowerCase()
      const toolName: string = t.name ?? t.tool_name ?? t.toolName
      if (!slug || !toolName) continue
      this.indexAliases(next, slug, toolName)
    }
    this.map = next
    this.saveCache()
  }

  stop(): void {
    if (this.dailyTimer) { clearInterval(this.dailyTimer); this.dailyTimer = null }
  }

  private indexAliases(map: Map<string, string>, slug: string, toolName: string): void {
    const upperSlug = slug.toUpperCase()
    let stripped = toolName.startsWith(`${upperSlug}_`) ? toolName.slice(upperSlug.length + 1) : toolName
    stripped = stripped.toLowerCase()
    map.set(`${slug}:${stripped}`, toolName)
    const parts = stripped.split('_')
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('_')
      if (!map.has(`${slug}:${suffix}`)) map.set(`${slug}:${suffix}`, toolName)
    }
    if (parts.length > 1 && !map.has(`${slug}:${parts[0]}`)) {
      map.set(`${slug}:${parts[0]!}`, toolName)
    }
  }

  private loadCache(): boolean {
    if (!existsSync(this.cachePath)) return false
    try {
      const cf = JSON.parse(readFileSync(this.cachePath, 'utf8')) as CacheFile
      if (this.now() - cf.saved_at > CACHE_TTL_MS) return false
      this.map = new Map(Object.entries(cf.entries))
      return true
    } catch { return false }
  }

  private saveCache(): void {
    try {
      const dir = dirname(this.cachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const cf: CacheFile = { saved_at: this.now(), entries: Object.fromEntries(this.map) }
      writeFileSync(this.cachePath, JSON.stringify(cf, null, 2))
    } catch { /* swallow */ }
  }

  private startDailyTimer(): void {
    this.dailyTimer = setInterval(() => {
      this.refresh().catch(() => {})
    }, CACHE_TTL_MS)
  }
}

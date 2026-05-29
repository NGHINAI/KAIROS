// src/daemon/connectors/triggers/schemaCache.ts
// Caches Composio trigger types (config + payload schemas + description).
// Used by OrdersAuthor at compile time, by Normalizer at runtime.
// 24h refresh, on-miss refresh rate-limited to 1/hour per slug.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { homedir } from 'os'
import { join } from 'path'
import type { TriggerType } from './types'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const ONMISS_REFRESH_INTERVAL_MS = 60 * 60 * 1000

export type TriggerSchemaCacheDeps = {
  composio: { sdk: { triggers: { get_type: (slug: string) => Promise<any> } } }
  cachePath?: string
  slugsToLoad?: string[]
  now?: () => number
}

type CacheFile = { saved_at: number; entries: Record<string, TriggerType> }

export class TriggerSchemaCache {
  private map = new Map<string, TriggerType>()
  private lastMissRefreshAt = new Map<string, number>()
  private cachePath: string
  private now: () => number

  constructor(private deps: TriggerSchemaCacheDeps) {
    this.cachePath = deps.cachePath ?? join(homedir(), '.kairos', 'trigger-schemas-cache.json')
    this.now = deps.now ?? Date.now
  }

  async initialize(): Promise<void> {
    if (this.loadCache()) return
    if (this.deps.slugsToLoad) {
      for (const slug of this.deps.slugsToLoad) {
        try {
          const t = await this.deps.composio.sdk.triggers.get_type(slug)
          this.map.set(slug, this.normalize(t))
        } catch { /* skip — slug unknown */ }
      }
    }
    this.saveCache()
  }

  getType(slug: string): TriggerType | null {
    return this.map.get(slug) ?? null
  }

  async resolveOrRefresh(slug: string): Promise<TriggerType | null> {
    const hit = this.getType(slug)
    if (hit) return hit
    const now = this.now()
    const last = this.lastMissRefreshAt.get(slug) ?? -Infinity
    if (now - last < ONMISS_REFRESH_INTERVAL_MS) return null
    this.lastMissRefreshAt.set(slug, now)
    try {
      const t = await this.deps.composio.sdk.triggers.get_type(slug)
      const normalized = this.normalize(t)
      this.map.set(slug, normalized)
      this.saveCache()
      return normalized
    } catch {
      return null
    }
  }

  private normalize(t: any): TriggerType {
    return {
      slug: t.slug ?? t.name,
      toolkit: (t.toolkit?.slug ?? t.toolkit_slug ?? t.toolkit ?? '').toLowerCase(),
      config_schema: t.config ?? t.config_schema ?? {},
      payload_schema: t.payload ?? t.payload_schema ?? {},
      description: t.description ?? '',
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
}

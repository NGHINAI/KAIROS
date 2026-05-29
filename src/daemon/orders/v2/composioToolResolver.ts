// src/daemon/orders/v2/composioToolResolver.ts
// Composio tool catalog. Two concerns, one cache:
//   1. RESOLVE — friendly {toolkit, name} → canonical Composio slug (for executeTool).
//   2. AUTHOR — full tool descriptors (slug, friendly name, description, input schema, toolkit)
//      so OrdersAuthor can show the LLM what action tools exist + what args they take.
//
// Without (2), KAIROS-authored rules would have to GUESS at action tool args. With it,
// rules can be generated against authoritative Composio schemas.
//
// Caches to ~/.kairos/composio-tools-cache.json (warm-boot < 50ms). Daily refresh.
// On-miss refresh is rate-limited to once per hour.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const ONMISS_REFRESH_INTERVAL_MS = 60 * 60 * 1000

export type ComposioToolResolverDeps = {
  // @composio/core@0.10.0 exposes getRawComposioTools (NOT tools.list). The return shape is
  // an array of tool descriptors, not { items: [...] } — we handle both defensively.
  composio: { sdk: { tools: { getRawComposioTools: (opts?: any) => Promise<any> } } }
  userId: string
  cachePath?: string
  now?: () => number
}

/** A Composio action tool, in the shape OrdersAuthor needs to brief the LLM. */
export type ToolDescriptor = {
  slug: string                  // canonical, e.g. 'GMAIL_SEND_EMAIL'
  friendly: string              // stripped of toolkit prefix, e.g. 'send_email'
  toolkit: string               // toolkit slug, e.g. 'gmail'
  description: string
  inputParameters: any          // JSON-schema-ish; Composio's tool input definition
}

type CacheFile = {
  saved_at: number
  /** Alias map: `${toolkit}:${friendly}` → canonical slug. */
  aliases: Record<string, string>
  /** Canonical slug → full descriptor. */
  descriptors: Record<string, ToolDescriptor>
}

export class ComposioToolResolver {
  private aliases = new Map<string, string>()
  private descriptors = new Map<string, ToolDescriptor>()
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

  // ── RESOLVE path (used by ActionDispatcher) ────────────────────────────

  resolve(toolkit: string, friendlyName: string): string | null {
    const key = `${toolkit.toLowerCase()}:${friendlyName.toLowerCase()}`
    return this.aliases.get(key) ?? null
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

  // ── AUTHOR path (used by OrdersAuthor to brief the LLM) ────────────────

  /** Look up a tool's full descriptor (input schema, description, etc.) by canonical slug. */
  getDescriptor(canonicalSlug: string): ToolDescriptor | null {
    return this.descriptors.get(canonicalSlug) ?? null
  }

  /** All action tools for a connected toolkit. Stable order: by canonical slug. */
  listToolsForToolkit(toolkit: string): ToolDescriptor[] {
    const lower = toolkit.toLowerCase()
    const out: ToolDescriptor[] = []
    for (const d of this.descriptors.values()) {
      if (d.toolkit === lower) out.push(d)
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug))
    return out
  }

  // ── Refresh + cache ────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    const result: any = await this.deps.composio.sdk.tools.getRawComposioTools({ limit: 500 })
    // getRawComposioTools can return either { items: [...] } or a bare array depending
    // on SDK version. Handle both shapes; this is canonical-defensive.
    const items: any[] = Array.isArray(result) ? result : (result?.items ?? [])
    const aliases = new Map<string, string>()
    const descriptors = new Map<string, ToolDescriptor>()
    for (const t of items) {
      const toolkitSlug = (t.toolkit?.slug ?? t.toolkit_slug ?? '').toLowerCase()
      const canonical: string = t.slug ?? t.name ?? t.tool_name ?? t.toolName
      if (!toolkitSlug || !canonical) continue
      this.indexAliases(aliases, toolkitSlug, canonical)
      const friendly = this.stripPrefix(toolkitSlug, canonical)
      descriptors.set(canonical, {
        slug: canonical,
        friendly,
        toolkit: toolkitSlug,
        description: typeof t.description === 'string' ? t.description : '',
        inputParameters: t.inputParameters ?? t.input_parameters ?? t.inputSchema ?? {},
      })
    }
    this.aliases = aliases
    this.descriptors = descriptors
    this.saveCache()
  }

  stop(): void {
    if (this.dailyTimer) { clearInterval(this.dailyTimer); this.dailyTimer = null }
  }

  private stripPrefix(toolkitSlug: string, canonical: string): string {
    const upper = toolkitSlug.toUpperCase()
    const stripped = canonical.startsWith(`${upper}_`) ? canonical.slice(upper.length + 1) : canonical
    return stripped.toLowerCase()
  }

  private indexAliases(map: Map<string, string>, slug: string, toolName: string): void {
    const stripped = this.stripPrefix(slug, toolName)
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
      const cf = JSON.parse(readFileSync(this.cachePath, 'utf8')) as Partial<CacheFile> & { entries?: Record<string, string> }
      if (typeof cf.saved_at !== 'number') return false
      if (this.now() - cf.saved_at > CACHE_TTL_MS) return false
      // Back-compat: older caches used { entries: aliasMap } only — no descriptors.
      // Treat as missing-descriptors → force a refresh by returning false.
      if (!cf.descriptors || !cf.aliases) {
        if (cf.entries) {
          // Load just the alias map for resolve() to work pending refresh, but tell
          // initialize() to refresh by returning false. The aliases are wasted bytes;
          // refresh() overwrites them.
        }
        return false
      }
      this.aliases = new Map(Object.entries(cf.aliases))
      this.descriptors = new Map(Object.entries(cf.descriptors))
      return true
    } catch { return false }
  }

  private saveCache(): void {
    try {
      const dir = dirname(this.cachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const cf: CacheFile = {
        saved_at: this.now(),
        aliases: Object.fromEntries(this.aliases),
        descriptors: Object.fromEntries(this.descriptors),
      }
      writeFileSync(this.cachePath, JSON.stringify(cf, null, 2))
    } catch { /* swallow */ }
  }

  private startDailyTimer(): void {
    this.dailyTimer = setInterval(() => {
      this.refresh().catch(() => {})
    }, CACHE_TTL_MS)
  }
}

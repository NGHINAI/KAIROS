// src/daemon/connectors/toolkitResolver.ts
// GENERAL Composio toolkit discovery. From ANY fuzzy user phrase ("calendar",
// "google calendar", "find me a chicken delivery app", "the thing I use for
// tickets") resolve the CORRECT live Composio toolkit slug by searching the LIVE
// catalog — NO alias maps, NO hardcoded lists.
//
// Resolution order (each falls through to the next, never throws):
//   1. EXACT slug — if the normalized phrase IS a catalog slug, return it (score 1).
//   2. LIVE toolkit search — prefer `client.toolkits.list({ search })` (matches
//      name + slug + DESCRIPTION; best for description-style phrases). Fall back to
//      `tools.getRawComposioTools({ search })` reduced to distinct toolkits ranked
//      by hit-count when `client` is unreachable.
//   3. LOCAL ranker over the cached full catalog snapshot — tie-breaks the live
//      results and serves as the offline fallback when live search throws/empties.
//
// Mirrors ComposioToolResolver's cache discipline: a JSON snapshot under ~/.kairos
// with a 24h TTL, a daily refresh timer, and an on-miss refresh throttled to once
// per hour. The snapshot uses `toolkits.list({ limit: 1000 })` (which — unlike the
// tools endpoint — has no required-filter constraint), so the offline path covers
// the entire ~500-900 toolkit catalog.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const ONMISS_REFRESH_INTERVAL_MS = 60 * 60 * 1000
const ONMISS_FAIL_BACKOFF_MS = 2 * 60 * 1000 // shorter retry window after an empty/failed refresh
const CATALOG_FETCH_LIMIT = 1000

/** A single toolkit in the catalog, normalized to the camelCase/meta.* raw shape. */
export type ToolkitCatalogEntry = {
  slug: string
  name: string
  description?: string
  categories?: string[]
}

export type ToolkitMatch = {
  slug: string
  name: string
  description?: string
  score: number
}

export type ToolkitResolveResult = {
  matches: ToolkitMatch[]
  best?: string
}

/** Minimal Composio-instance shape we depend on. `composioClient.sdk` satisfies it.
 *  Everything is optional/defensive — any path that's missing simply falls through. */
export type ComposioInstanceLike = {
  tools?: {
    getRawComposioTools?: (opts?: any) => Promise<any>
  }
  client?: {
    toolkits?: {
      list?: (opts?: any) => Promise<any>
    }
  }
}

export type ToolkitResolverDeps = {
  /** The Composio instance — pass `composioClient.sdk`. */
  composio: ComposioInstanceLike
  cacheDir?: string
  now?: () => number
  /** Injectable catalog fetch (tests avoid the network). Defaults to the live
   *  `client.toolkits.list({ limit: 1000 })` snapshot. */
  fetchCatalog?: () => Promise<ToolkitCatalogEntry[]>
}

export class ToolkitResolver {
  private catalog: ToolkitCatalogEntry[] = []
  private bySlug = new Map<string, ToolkitCatalogEntry>()
  private cachePath: string
  private now: () => number
  private dailyTimer: ReturnType<typeof setInterval> | null = null
  private lastOnMissRefreshAt = -ONMISS_REFRESH_INTERVAL_MS
  private lastOnMissOk = false // was the most recent on-miss refresh successful (non-empty)?
  private loaded = false

  constructor(private deps: ToolkitResolverDeps) {
    const dir = deps.cacheDir ?? join(homedir(), '.kairos')
    this.cachePath = join(dir, 'composio-toolkit-catalog.json')
    this.now = deps.now ?? Date.now
  }

  /** Load the cached catalog (or refresh if stale/missing) and start the daily timer.
   *  Optional — `resolve()` lazy-loads on first call too, so boot can skip awaiting this. */
  async initialize(): Promise<void> {
    if (!this.loadCache()) {
      await this.refreshCatalog()
    }
    this.loaded = true
    this.startDailyTimer()
  }

  stop(): void {
    if (this.dailyTimer) { clearInterval(this.dailyTimer); this.dailyTimer = null }
  }

  /**
   * Resolve a fuzzy phrase to the best Composio toolkit slug(s).
   * NEVER throws — on total failure returns `{ matches: [] }`.
   */
  async resolve(phrase: string): Promise<ToolkitResolveResult> {
    try {
      const raw = String(phrase ?? '')
      const normalized = normalize(raw)
      if (!normalized) return { matches: [] }

      // Lazy-load the catalog snapshot once (offline fallback + exact-slug check).
      await this.ensureCatalog()

      // 1. EXACT slug short-circuit.
      const exact = this.bySlug.get(normalized)
      if (exact) {
        return {
          matches: [{ slug: exact.slug, name: exact.name, description: exact.description, score: 1 }],
          best: exact.slug,
        }
      }

      // 2. LIVE search (toolkit-level first, then tools-reduced).
      let live: ToolkitCatalogEntry[] = []
      try {
        live = await this.liveSearch(raw)
      } catch { /* fall through to local ranker */ }

      // 3. LOCAL ranker — over the live results when present, else the full catalog.
      //    The ranker re-scores so live hits get tie-broken consistently with the
      //    offline path; an empty `live` means we rank the whole catalog (substring
      //    fallback for "the thing I use for tickets" when live search is down).
      const pool = live.length > 0 ? live : this.catalog
      const ranked = this.rankLocal(raw, pool)
      if (ranked.length > 0) {
        return { matches: ranked, best: ranked[0]!.slug }
      }

      // Live had hits but ranker scored them all zero (rare) — surface them as-is.
      if (live.length > 0) {
        const matches = live.slice(0, 3).map((t) => ({ slug: t.slug, name: t.name, description: t.description, score: 0 }))
        return { matches, best: matches[0]!.slug }
      }

      // Total miss against a possibly-stale snapshot with no live signal: trigger a
      // throttled refresh and re-rank once. Catches catalog additions (a newly-listed
      // "chicken delivery app") without hammering the API on every miss.
      await this.maybeRefreshOnMiss()
      const reranked = this.rankLocal(raw, this.catalog)
      if (reranked.length > 0) {
        return { matches: reranked, best: reranked[0]!.slug }
      }

      return { matches: [] }
    } catch {
      return { matches: [] }
    }
  }

  // ── Live search ────────────────────────────────────────────────────────

  /** Prefer `client.toolkits.list({ search })` (name+slug+description). Fall back
   *  to `tools.getRawComposioTools({ search })` reduced to distinct toolkits ranked
   *  by hit-count. Returns [] if neither path is reachable. */
  private async liveSearch(phrase: string): Promise<ToolkitCatalogEntry[]> {
    const list = this.deps.composio.client?.toolkits?.list
    if (typeof list === 'function') {
      const r: any = await list.call(this.deps.composio.client!.toolkits, { search: phrase, limit: 20 })
      const items: any[] = Array.isArray(r) ? r : (r?.items ?? [])
      const mapped = items.map(toCatalogEntry).filter((t): t is ToolkitCatalogEntry => !!t && !!t.slug)
      if (mapped.length > 0) return mapped
    }

    const getRaw = this.deps.composio.tools?.getRawComposioTools
    if (typeof getRaw === 'function') {
      const r: any = await getRaw.call(this.deps.composio.tools, { search: phrase, limit: 50 })
      const tools: any[] = Array.isArray(r) ? r : (r?.items ?? [])
      return reduceToolsToToolkits(tools)
    }

    return []
  }

  // ── Local ranker ───────────────────────────────────────────────────────

  /** Pure, static-map-free ranker. Tie-break for live results + offline fallback.
   *  Signal ordering (highest first): exact slug → startsWith(slug|name) →
   *  token-overlap on name+description+categories → substring. Returns top 3. */
  private rankLocal(phrase: string, pool: ToolkitCatalogEntry[]): ToolkitMatch[] {
    const norm = normalize(phrase)
    const tokens = tokenize(phrase)
    const scored: ToolkitMatch[] = []

    for (const t of pool) {
      const slug = normalize(t.slug)
      const nameNorm = normalize(t.name)
      let score = 0

      if (slug === norm || nameNorm === norm) {
        score = 1
      } else if (slug.startsWith(norm) || nameNorm.startsWith(norm) || norm.startsWith(slug)) {
        score = 0.85
      } else {
        // Token overlap on name + description + categories.
        const haystack = tokenize(
          `${t.name ?? ''} ${t.description ?? ''} ${(t.categories ?? []).join(' ')}`,
        )
        const haystackSet = new Set(haystack)
        let overlap = 0
        for (const tok of tokens) {
          if (haystackSet.has(tok)) overlap++
        }
        if (tokens.length > 0 && overlap > 0) {
          score = 0.4 + 0.4 * (overlap / tokens.length)
        } else if (slug.includes(norm) || nameNorm.includes(norm)) {
          // Substring fallback (e.g. catalog has "googlecalendar", phrase "calendar").
          score = 0.3
        } else if (norm.length >= 3 && (norm.includes(slug) || norm.includes(nameNorm))) {
          score = 0.25
        }
      }

      if (score > 0) {
        scored.push({ slug: t.slug, name: t.name, description: t.description, score })
      }
    }

    scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug))
    return scored.slice(0, 3)
  }

  // ── Catalog snapshot + cache ─────────────────────────────────────────────

  private async ensureCatalog(): Promise<void> {
    if (this.loaded) return
    if (!this.loadCache()) {
      await this.refreshCatalog()
    }
    this.loaded = true
  }

  private async refreshCatalog(): Promise<boolean> {
    try {
      const entries = await this.fetchCatalog()
      if (entries.length > 0) {
        this.setCatalog(entries)
        this.saveCache()
        return true
      }
      return false
    } catch { return false /* keep whatever we have; resolve() still works off live search */ }
  }

  /** On-miss throttled refresh. A SUCCESSFUL (non-empty) refresh throttles for the
   *  full hour; a transient empty/down result only backs off ~2min so a flaky/late
   *  catalog isn't locked out of retries for an hour (the old code set the 1h stamp
   *  BEFORE awaiting, so one transient empty froze all retries). */
  private async maybeRefreshOnMiss(): Promise<void> {
    const now = this.now()
    const interval = this.lastOnMissOk ? ONMISS_REFRESH_INTERVAL_MS : ONMISS_FAIL_BACKOFF_MS
    if (now - this.lastOnMissRefreshAt >= interval) {
      this.lastOnMissRefreshAt = now
      this.lastOnMissOk = await this.refreshCatalog()
    }
  }

  private async fetchCatalog(): Promise<ToolkitCatalogEntry[]> {
    if (this.deps.fetchCatalog) return this.deps.fetchCatalog()
    // `toolkits.list` has NO required-filter constraint (unlike the tools endpoint),
    // so an unfiltered snapshot is allowed.
    const list = this.deps.composio.client?.toolkits?.list
    if (typeof list !== 'function') return []
    const r: any = await list.call(this.deps.composio.client!.toolkits, { limit: CATALOG_FETCH_LIMIT })
    const items: any[] = Array.isArray(r) ? r : (r?.items ?? [])
    return items.map(toCatalogEntry).filter((t): t is ToolkitCatalogEntry => !!t && !!t.slug)
  }

  private setCatalog(entries: ToolkitCatalogEntry[]): void {
    this.catalog = entries
    this.bySlug = new Map(entries.map((e) => [normalize(e.slug), e]))
  }

  private loadCache(): boolean {
    if (!existsSync(this.cachePath)) return false
    try {
      const cf = JSON.parse(readFileSync(this.cachePath, 'utf8')) as { saved_at?: number; toolkits?: ToolkitCatalogEntry[] }
      if (typeof cf.saved_at !== 'number' || !Array.isArray(cf.toolkits)) return false
      if (this.now() - cf.saved_at > CACHE_TTL_MS) return false
      this.setCatalog(cf.toolkits)
      return true
    } catch { return false }
  }

  private saveCache(): void {
    try {
      const dir = dirname(this.cachePath)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(this.cachePath, JSON.stringify({ saved_at: this.now(), toolkits: this.catalog }, null, 2))
    } catch { /* swallow */ }
  }

  private startDailyTimer(): void {
    this.dailyTimer = setInterval(() => {
      this.refreshCatalog().catch(() => {})
    }, CACHE_TTL_MS)
  }
}

// ── Helpers (exported for tests) ───────────────────────────────────────────

/** lowercase + strip all non-alphanumerics ("Google Calendar" → "googlecalendar"). */
export function normalize(s: string): string {
  return String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** Split into lowercased word tokens (>=2 chars), dropping a few stopwords that
 *  bloat description-style phrases ("the thing I use for tickets"). */
export function tokenize(s: string): string[] {
  const STOP = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'my', 'me', 'i', 'use', 'used', 'using', 'thing', 'app', 'find', 'that', 'with', 'and'])
  return String(s ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !STOP.has(t))
}

/** Normalize a raw toolkit item (from toolkits.list — `{ name, slug, meta: {...} }`)
 *  into a ToolkitCatalogEntry. Reads the RIGHT nesting (`meta.description`/camelCase),
 *  unlike composioClient.listToolkits which reads the flat shape and gets empties. */
export function toCatalogEntry(t: any): ToolkitCatalogEntry | null {
  if (!t) return null
  const slug = t.slug ?? t.toolkit_slug ?? t.toolkit?.slug
  if (!slug) return null
  const meta = t.meta ?? {}
  return {
    slug: String(slug),
    name: String(t.name ?? meta.name ?? slug),
    description: t.description ?? meta.description ?? undefined,
    categories: Array.isArray(t.categories) ? t.categories
      : Array.isArray(meta.categories) ? meta.categories.map((c: any) => (typeof c === 'string' ? c : c?.name ?? c?.slug)).filter(Boolean)
      : undefined,
  }
}

/** Reduce a `Tool[]` (from getRawComposioTools) to distinct toolkits, ranked by
 *  how many tools each toolkit contributed (more hits = stronger match). */
export function reduceToolsToToolkits(tools: any[]): ToolkitCatalogEntry[] {
  const counts = new Map<string, { entry: ToolkitCatalogEntry; hits: number }>()
  for (const tool of tools ?? []) {
    const tk = tool?.toolkit
    const slug = (typeof tk === 'string' ? tk : tk?.slug) ?? tool?.toolkit_slug
    if (!slug) continue
    const key = String(slug)
    const existing = counts.get(key)
    if (existing) {
      existing.hits++
    } else {
      counts.set(key, {
        entry: {
          slug: key,
          name: String((typeof tk === 'object' ? tk?.name : undefined) ?? key),
        },
        hits: 1,
      })
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.hits - a.hits)
    .map((c) => c.entry)
}

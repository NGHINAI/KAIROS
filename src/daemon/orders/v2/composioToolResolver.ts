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

// The model labels each tool read/write from its own name+description (no verb list).
const NATURE_SYSTEM =
  "You label developer API tools as 'read' or 'write'. " +
  "'read' = the tool ONLY retrieves, lists, searches, gets, counts, or exports data with NO side effects. " +
  "'write' = it creates, updates, deletes, sends, posts, replies, books, schedules, pays, moves, archives, " +
  "or otherwise CHANGES external state. You are given a JSON array of {slug, description}. " +
  "Return STRICT JSON: an object mapping each slug to exactly 'read' or 'write'. When unsure, answer 'write' (the safe side)."

/** Parse a JSON object out of an LLM reply, tolerating ```json fences / prose wrappers. */
function extractJsonObject(text: string): any {
  let s = String(text ?? '').trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1]!.trim()
  if (!s.startsWith('{')) { const m = s.match(/\{[\s\S]*\}/); if (m) s = m[0] }
  try { return JSON.parse(s) } catch { return null }
}

export type ComposioToolResolverDeps = {
  // @composio/core@0.10.0 exposes getRawComposioTools (NOT tools.list). The return shape is
  // an array of tool descriptors, not { items: [...] } — we handle both defensively.
  composio: { sdk: { tools: { getRawComposioTools: (opts?: any) => Promise<any> } } }
  userId: string
  cachePath?: string
  now?: () => number
  /** Connected toolkit slugs to catalog. REQUIRED at runtime: @composio/core@0.10.0
   *  rejects getRawComposioTools without a filter ({tools|toolkits|search|authConfigIds}),
   *  so we fetch per connected toolkit. Without this the catalog is empty (no crash). */
  toolkits?: () => string[] | Promise<string[]>
  /** Cheap LLM used to classify each tool's read/write nature ONCE from its name +
   *  description (result is cached). Omit → nature stays undefined (callers default
   *  to the safe side). Same {complete} shape as the verifier/memory completers. */
  classifyLlm?: { complete: (body: any) => Promise<{ text: string }> }
  /** Called after refresh/load with the current slug→nature map, so the verifier /
   *  stream controller / approval gate can consult it (via setToolNature). */
  onNature?: (map: Map<string, 'read' | 'write'>) => void
  log?: (msg: string) => void
}

/** A Composio action tool, in the shape OrdersAuthor needs to brief the LLM. */
export type ToolDescriptor = {
  slug: string                  // canonical, e.g. 'GMAIL_SEND_EMAIL'
  friendly: string              // stripped of toolkit prefix, e.g. 'send_email'
  toolkit: string               // toolkit slug, e.g. 'gmail'
  description: string
  inputParameters: any          // JSON-schema-ish; Composio's tool input definition
  /** Agentic read/write classification — the MODEL's one-time labelling of this tool
   *  from its description (no verb list). 'read' = retrieves only; 'write' = mutates
   *  external state. Cached; drives latency tiering + approval gating downstream. */
  nature?: 'read' | 'write'
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
      await this.classifyNatures()  // fill nature for any cached tools missing it (e.g. pre-nature cache)
      this.emitNature()
      this.startDailyTimer()
      return
    }
    await this.refresh()            // refresh classifies + emits
    this.startDailyTimer()
  }

  /** slug → 'read'|'write' for every classified tool (the source of truth wired into
   *  the verifier / stream controller / approval gate). */
  natureMap(): Map<string, 'read' | 'write'> {
    const m = new Map<string, 'read' | 'write'>()
    for (const [slug, d] of this.descriptors) if (d.nature) m.set(slug, d.nature)
    return m
  }

  private emitNature(): void { try { this.deps.onNature?.(this.natureMap()) } catch { /* */ } }

  /** Classify (ONCE, batched, best-effort) the read/write nature of any descriptor
   *  that lacks it — the model labels each tool from its own name + description, so
   *  it generalizes to ANY toolkit with no hardcoded verb list. Persists results. */
  private async classifyNatures(): Promise<void> {
    if (!this.deps.classifyLlm) return
    const todo = [...this.descriptors.values()].filter((d) => !d.nature)
    if (todo.length === 0) return
    const BATCH = 40
    let changed = 0
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH)
      try {
        const resp = await this.deps.classifyLlm.complete({
          messages: [
            { role: 'system', content: NATURE_SYSTEM },
            { role: 'user', content: JSON.stringify(batch.map((d) => ({ slug: d.slug, description: (d.description || d.friendly).slice(0, 220) }))) },
          ],
          max_tokens: 1800,
          temperature: 0,
        })
        const parsed = extractJsonObject(resp.text)  // tolerant of ```json fences / prose wrappers
        for (const d of batch) {
          const v = parsed?.[d.slug]
          if (v === 'read' || v === 'write') { d.nature = v; changed++ }
        }
      } catch { /* leave unclassified — downstream defaults safely */ }
    }
    if (changed > 0) { this.saveCache(); this.deps.log?.(`[orders-v2] classified ${changed}/${todo.length} tools read/write`) }
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

  /** All toolkit slugs that have at least one action tool in the catalog.
   *  Used by OrdersAuthor to tell the LLM about available-but-unconnected toolkits
   *  so it can propose rules referencing them — KAIROS will then prompt OAuth. */
  listAllToolkits(): string[] {
    const set = new Set<string>()
    for (const d of this.descriptors.values()) set.add(d.toolkit)
    return [...set].sort()
  }

  // ── Refresh + cache ────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    const items: any[] = []
    if (this.deps.toolkits) {
      // @composio/core@0.10.0 REQUIRES a filter (one of tools|toolkits|search|authConfigIds)
      // — calling with just {limit} throws a ValidationError. Fetch per connected toolkit.
      const slugs = [...new Set((await this.deps.toolkits()).filter(Boolean))]
      for (const slug of slugs) {
        try {
          const r: any = await this.deps.composio.sdk.tools.getRawComposioTools({ toolkits: [slug], limit: 200 })
          items.push(...(Array.isArray(r) ? r : (r?.items ?? [])))
        } catch { /* one bad toolkit shouldn't sink the whole catalog */ }
      }
    } else {
      // No toolkits provider (tests / legacy callers) — unfiltered fetch.
      const result: any = await this.deps.composio.sdk.tools.getRawComposioTools({ limit: 500 })
      items.push(...(Array.isArray(result) ? result : (result?.items ?? [])))
    }
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
        nature: this.descriptors.get(canonical)?.nature, // carry over a prior classification (no re-LLM)
      })
    }
    this.aliases = aliases
    this.descriptors = descriptors
    this.saveCache()
    await this.classifyNatures()  // classify any newly-seen tools (re-saves if changed)
    this.emitNature()
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

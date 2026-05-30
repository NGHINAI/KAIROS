// src/daemon/agents/contextBuilder.ts
// Layered system-prompt assembly with session-level prefix caching (Hermes pattern).

import type { ToolDef, Tier } from "./types"

interface MemoryHit { source: "L2" | "L3" | "L4"; text: string; ts?: number }

interface SessionPrefix {
  system: string
  tools: ToolDef[]
  cacheKey: string
}

interface TurnDelta {
  recentTurns: Array<{ role: string; text: string; at: number }>
  memoryHits: MemoryHit[]
  utterance: string
}

export interface ContextBuilderDeps {
  loaders: {
    soulDigest:            () => Promise<string>
    standingOrdersSummary: () => Promise<string>
    memoryOverview:        () => Promise<string>
    kairosSkills:          () => Promise<ToolDef[]>
    introspectionTools:    () => Promise<ToolDef[]>
  }
  memoryInjector?:    { inject: (query: string, opts?: any) => Promise<MemoryHit[]> }
  conversationStore?: { recentTurns: (id: string, n: number) => Promise<Array<{ role: string; text: string; at: number }>> }
}

export class ContextBuilder {
  private cachedPrefix: SessionPrefix | undefined

  constructor(private deps: ContextBuilderDeps) {}

  async buildSessionPrefix(): Promise<SessionPrefix> {
    if (this.cachedPrefix) return this.cachedPrefix

    const [soul, orders, mem, skills, introTools] = await Promise.all([
      this.deps.loaders.soulDigest(),
      this.deps.loaders.standingOrdersSummary(),
      this.deps.loaders.memoryOverview(),
      this.deps.loaders.kairosSkills(),
      this.deps.loaders.introspectionTools(),
    ])

    const system = [
      "## Persona",
      soul,
      "",
      "## Active standing orders",
      orders || "(none)",
      "",
      "## Long-term memory (MEMORY.md)",
      mem || "(empty)",
      "",
      "You are KAIROS, a proactive AI co-worker. Respond conversationally as if speaking aloud. Plain spoken English only, no markdown. Use the available tools to answer questions about KAIROS systems or to take actions for the user. Confirm before destructive edits.",
    ].join("\n")

    this.cachedPrefix = {
      system,
      tools: [...introTools, ...skills],
      cacheKey: `s${Date.now()}`,
    }
    return this.cachedPrefix
  }

  invalidatePrefix(): void {
    this.cachedPrefix = undefined
  }

  async buildTurnDelta(opts: { utterance: string; conversationId: string }): Promise<TurnDelta> {
    const [recent, hits] = await Promise.all([
      this.deps.conversationStore?.recentTurns(opts.conversationId, 3) ?? Promise.resolve([]),
      this.deps.memoryInjector?.inject(opts.utterance, { max_l2: 3, max_l3: 5, include_l4: false }) ?? Promise.resolve([]),
    ])
    return { recentTurns: recent, memoryHits: hits, utterance: opts.utterance }
  }

  async build(opts: { utterance: string; tier: Tier; conversationId?: string }): Promise<{ system: string; tools: ToolDef[] }> {
    const prefix = await this.buildSessionPrefix()
    if (!opts.conversationId) {
      return { system: prefix.system, tools: prefix.tools }
    }
    const delta = await this.buildTurnDelta({ utterance: opts.utterance, conversationId: opts.conversationId })
    const deltaText = renderDelta(delta)
    return {
      system: prefix.system + "\n\n## Current context\n" + deltaText,
      tools: prefix.tools,
    }
  }
}

function renderDelta(d: TurnDelta): string {
  const lines: string[] = []
  if (d.recentTurns.length > 0) {
    lines.push("### Recent conversation")
    for (const t of d.recentTurns) lines.push(`${t.role}: ${t.text}`)
  }
  if (d.memoryHits.length > 0) {
    lines.push("\n### Relevant memory")
    for (const h of d.memoryHits) lines.push(`[${h.source}] ${h.text}`)
  }
  return lines.join("\n")
}

// Keep ContextBuilderStub as a named export so daemon (index.ts) still
// compiles until Task 3.4 swaps it for the real ContextBuilder.
export class ContextBuilderStub {
  async build(_input: { utterance: string; tier: Tier }): Promise<{ system: string; tools: ToolDef[] }> {
    return {
      system: "You are KAIROS, a proactive AI co-worker. Respond conversationally, plain text only, 1-2 sentences typical.",
      tools: [],
    }
  }
}

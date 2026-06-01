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
    /** "## About the user" block — learned profile + live preference hints. Optional. */
    aboutUser?:            () => Promise<string>
  }
  memoryInjector?:    { inject: (query: string, opts?: any) => Promise<MemoryHit[]> }
  conversationStore?: { recentTurns: (id: string, n: number) => Promise<Array<{ role: string; text: string; at: number }>> }
}

export class ContextBuilder {
  private cachedPrefix: SessionPrefix | undefined

  constructor(private deps: ContextBuilderDeps) {}

  async buildSessionPrefix(): Promise<SessionPrefix> {
    if (this.cachedPrefix) return this.cachedPrefix

    const [soul, aboutUser, orders, mem, skills, introTools] = await Promise.all([
      this.deps.loaders.soulDigest(),
      this.deps.loaders.aboutUser?.() ?? Promise.resolve(""),
      this.deps.loaders.standingOrdersSummary(),
      this.deps.loaders.memoryOverview(),
      this.deps.loaders.kairosSkills(),
      this.deps.loaders.introspectionTools(),
    ])

    const system = [
      "## Persona",
      soul,
      "",
      // The learned user profile + active preferences. This is what makes replies
      // personalized — KAIROS adapts tone, length, and behavior to who you are.
      ...(aboutUser ? ["## About the user", aboutUser, ""] : []),
      "## Active standing orders",
      orders || "(none)",
      "",
      "## Long-term memory (MEMORY.md)",
      mem || "(empty)",
      "",
      "## How you talk and act",
      "You are KAIROS, a proactive AI coworker. Everything you say is spoken aloud through text-to-speech, so write for the ear, not the eye:",
      "- Plain spoken English. No markdown, lists, bullets, code blocks, URLs, or emoji — they sound like noise.",
      "- Be brief. One or two sentences is the norm; only go longer when the user clearly wants detail.",
      "- Speak numbers, dates, and times naturally (\"three thirty\", \"about twelve dollars\", \"next Tuesday\"). Never read out IDs, raw JSON, or field names.",
      "- Use the user's name sparingly, contractions freely. Sound like a competent person, not a manual.",
      "Acting:",
      "- Use your tools to actually do things and to answer questions about KAIROS's own systems — don't guess when you can check.",
      "- If a request is ambiguous or missing a required detail, ask ONE short clarifying question instead of guessing.",
      "- Confirm out loud BEFORE anything destructive or irreversible: deleting data, sending messages, spending money, or changing config. Describe what you're about to do in one line and wait for a yes.",
      "- If a tool fails, say so plainly and offer the next step. Don't invent results.",
      "- Memory (facts about the user, preferences) is saved, updated, and deleted AUTOMATICALLY in the background. You do NOT have a tool to do it and must NEVER claim you saved, changed, remembered, or deleted a memory yourself. If asked to remember or forget something, briefly acknowledge (e.g. \"got it\" / \"okay\") — it's handled automatically — but do not assert it's done.",
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
      // include_l4: skills are already surfaced as tools in the session prefix,
      // so we keep L4 OUT of the per-turn memory delta to avoid duplication and
      // token bloat. L2 (episodic) + L3 (semantic facts) are the per-turn recall.
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

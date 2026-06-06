// src/daemon/agents/turnLogger.ts
// Human-readable + machine-readable log of every conversation turn AND every
// action the agent took. This is the observability layer: you can see exactly
// what KAIROS heard, which tier it used, which tools it actually CALLED (with
// args + results), and what it replied — so a claim like "your latest email is
// from Starbucks" can be verified against whether GMAIL_LIST_MESSAGES actually ran.
//
// It also flags two trust-killers automatically:
//  - LEAK: the reply contains raw tool-call markup (the model emitted a tool call
//    as text instead of executing it → the action never happened).
//  - "smart turn, no tools": a smart-tier turn that called zero tools, i.e. the
//    answer may be ungrounded/hallucinated.

export interface TurnToolCall {
  name: string
  args?: any
  result?: string
  error?: string
}

export interface TurnRecord {
  at: number
  conversationId: string
  utterance: string
  tier?: string
  toolCalls: TurnToolCall[]
  reply: string
}

export interface TurnLoggerDeps {
  appendLine: (humanLine: string) => void
  appendJsonl: (obj: any) => void
  now?: () => number
}

// Raw tool-call markup that should NEVER appear in a spoken reply.
const LEAK_RE = /<tool_call|tool_calls_section|<\|tool|functions\.[a-zA-Z_]+\s*[\{<]/

function hhmmss(ts: number): string {
  try { return new Date(ts).toISOString().slice(11, 19) } catch { return "??:??:??" }
}

function short(v: any, n = 120): string {
  if (v == null) return ""
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s.length > n ? s.slice(0, n) + "…" : s
}

export class TurnLogger {
  constructor(private deps: TurnLoggerDeps) {}

  record(entry: TurnRecord): void {
    const leaked = LEAK_RE.test(entry.reply ?? "")
    const smartNoTools = (entry.tier === "smart" || entry.tier === "deep") && entry.toolCalls.length === 0

    // Machine log
    this.deps.appendJsonl({
      at: entry.at,
      conversationId: entry.conversationId,
      utterance: entry.utterance,
      tier: entry.tier,
      toolCalls: entry.toolCalls,
      reply: entry.reply,
      leaked,
      smartNoTools,
    })

    // Human log
    const t = hhmmss(entry.at)
    const out: string[] = []
    out.push(`[${t}] (${entry.conversationId}) USER: ${entry.utterance}`)
    out.push(`           tier: ${entry.tier ?? "?"}`)
    for (const tc of entry.toolCalls) {
      const res = tc.error ? `ERROR: ${short(tc.error)}` : short(tc.result)
      out.push(`           tool: ${tc.name}(${short(tc.args, 80)})${res ? ` -> ${res}` : ""}`)
    }
    out.push(`           KAIROS: ${entry.reply}`)
    if (leaked) out.push(`           ⚠️  TOOL-CALL LEAK — the model emitted a tool call as TEXT; it did NOT execute. Answer is unreliable.`)
    if (smartNoTools && !leaked) out.push(`           ⚠️  smart turn ran with NO tools — answer may be ungrounded/hallucinated.`)
    this.deps.appendLine(out.join("\n"))
  }
}

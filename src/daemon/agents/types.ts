// src/daemon/agents/types.ts
// Core types for the voice agent orchestrator.

export type Tier = "fast" | "smart" | "deep" | "vision"

export const TIER_MODELS: Record<Tier, () => string> = {
  fast:   () => process.env.KAIROS_FAST_MODEL   ?? "openai/gpt-4o-mini",
  // SMART generates the SPOKEN reply — keep it a NON-reasoning model. Reasoning models
  // (kimi-k2.5, etc.) leak their chain-of-thought + recite the system prompt aloud.
  smart:  () => process.env.KAIROS_SMART_MODEL  ?? "openai/gpt-4o",
  deep:   () => process.env.KAIROS_DEEP_MODEL   ?? "moonshotai/kimi-k2-thinking",
  // Vision falls back to the SMART model (the one knob the user sets) before the
  // hardcoded OpenAI id — so a gemini-only user never silently hits gpt-4o.
  vision: () => process.env.KAIROS_VISION_MODEL ?? process.env.KAIROS_SMART_MODEL ?? "openai/gpt-4o",
}

/** Model for the grounding VERIFY gate (claim ⊆ tool results). Runs on tool turns
 *  only (~160-token judgments). Resolution order: KAIROS_VERIFY_MODEL → the SMART
 *  model (KAIROS_SMART_MODEL) → openai/gpt-4o as the terminal fallback. Tracking the
 *  smart model means the single knob the user sets governs every selection: a
 *  gemini-only user no longer fires silent gpt-4o verify calls. Pin
 *  KAIROS_VERIFY_MODEL to force a sharper, separate judge if smart is weak. */
export const verifyModel = (): string =>
  process.env.KAIROS_VERIFY_MODEL ?? process.env.KAIROS_SMART_MODEL ?? "openai/gpt-4o"

export interface IntentDecision {
  tier: Tier
  reason: string         // why this tier
  confidence: number     // 0..1
  /** Conservative per-task reasoning effort for the smart/deep brain (low default;
   *  the brain auto-escalates on failure). Maps to a per-turn proxy reasoning budget. */
  effort?: "low" | "medium" | "high"
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any>  // JSON Schema
  execute: (args: any) => Promise<any>
  /** Read-only / side-effect-free tool that's safe to run concurrently with
   *  other safe tools in the same turn (search/list/get/fetch). Writes leave
   *  this false (default) and run serially. */
  concurrencySafe?: boolean
}

/** The unified activity envelope (UI live-tree contract). Emitted ALONGSIDE the flat
 *  agent and task events so one UI tree can render Lane A turns, Lane B background
 *  sub-agents, and nested sub-agents (R5) identically — lineage via parentRunId. */
export interface AgentActivity {
  runId: string
  parentRunId: string | null
  depth: number
  lane: "A" | "B"
  conversationId?: string
  tier?: Tier
  /** planning | agent_delta | tool_call | tool_done | tool_failed | plan_update |
   *  compaction | self_correct | subagent_start | status | final */
  kind: string
  status?: "running" | "done" | "failed" | "cancelled"
  tool?: string
  summary?: string
  ts: number
}

export type AgentEvent =
  | { kind: "agent_intent";       tier: Tier; reason: string }
  | { kind: "agent_planning";     tier: Tier }
  | { kind: "agent_ack";          text: string; tier: Tier }
  | { kind: "agent_tool_call";    name: string; args: any; id: string }
  | { kind: "agent_tool_done";    name: string; id: string; result_summary: string }
  | { kind: "agent_tool_failed";  name: string; id: string; error: string }
  | { kind: "agent_status";       text: string }
  | { kind: "agent_delta";        text: string }
  | { kind: "agent_plan";         steps: Array<{ step: string; status: string }> }
  | { kind: "agent_activity";     activity: AgentActivity }
  | { kind: "agent_done";         text: string }
  | { kind: "agent_error";        message: string }
  | { kind: "agent_interrupted" }

export interface ConductorOpts {
  conversationId: string
  utterance: string
  signal?: AbortSignal
  /** Stable id for THIS foreground turn — root of the activity tree. Background
   *  sub-agents spawned during the turn link to it via parentRunId. */
  runId?: string
  /** Guide Mode: rendered lesson/last-highlight state. An active-walkthrough block
   *  ("## Active walkthrough…") makes the turn SKIP the fast front (a lesson turn
   *  always needs the guide tools); either way the block is appended to the
   *  planner's instructions when the planner runs. */
  lessonContext?: string
  /** True for daemon-injected turns (lesson auto-continue after the user's click) —
   *  no spoken ack before the planner; the next step IS the response. */
  synthetic?: boolean
}

export type AgentEventHandler = (e: AgentEvent) => void

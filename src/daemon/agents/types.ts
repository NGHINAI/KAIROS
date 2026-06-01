// src/daemon/agents/types.ts
// Core types for the voice agent orchestrator.

export type Tier = "fast" | "smart" | "deep" | "vision"

export const TIER_MODELS: Record<Tier, () => string> = {
  fast:   () => process.env.KAIROS_FAST_MODEL   ?? "openai/gpt-4o-mini",
  smart:  () => process.env.KAIROS_SMART_MODEL  ?? "moonshotai/kimi-k2",
  deep:   () => process.env.KAIROS_DEEP_MODEL   ?? "moonshotai/kimi-k2-thinking",
  vision: () => process.env.KAIROS_VISION_MODEL ?? "openai/gpt-4o",
}

export interface IntentDecision {
  tier: Tier
  reason: string         // why this tier
  confidence: number     // 0..1
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, any>  // JSON Schema
  execute: (args: any) => Promise<any>
}

export type AgentEvent =
  | { kind: "agent_intent";       tier: Tier; reason: string }
  | { kind: "agent_planning";     tier: Tier }
  | { kind: "agent_ack";          text: string; tier: Tier }
  | { kind: "agent_tool_call";    name: string; args: any; id: string }
  | { kind: "agent_tool_done";    name: string; id: string; result_summary: string }
  | { kind: "agent_tool_failed";  name: string; id: string; error: string }
  | { kind: "agent_status";       text: string }
  | { kind: "agent_done";         text: string }
  | { kind: "agent_error";        message: string }
  | { kind: "agent_interrupted" }

export interface ConductorOpts {
  conversationId: string
  utterance: string
  signal?: AbortSignal
}

export type AgentEventHandler = (e: AgentEvent) => void

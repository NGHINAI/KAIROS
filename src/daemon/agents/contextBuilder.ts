// src/daemon/agents/contextBuilder.ts
// E.2.1 stub — E.2.3 replaces this with full layered context.
import type { ToolDef, Tier } from "./types"

export class ContextBuilderStub {
  async build(_input: { utterance: string; tier: Tier }): Promise<{ system: string; tools: ToolDef[] }> {
    return {
      system: "You are KAIROS, a proactive AI co-worker. Respond conversationally, plain text only, 1-2 sentences typical.",
      tools: [],
    }
  }
}

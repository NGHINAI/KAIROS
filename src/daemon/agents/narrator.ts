// src/daemon/agents/narrator.ts
// Synchronous speak-while-acting coordinator. Wraps the Tier-1 executor
// helpers (ack / transition / filler) and pipes their output to whatever
// speak backend the daemon supplies. Used by the Conductor's smart path
// to keep the user engaged while the Planner executes tool calls.

import { generateAck, generateTransition, generateFiller } from "./executorAgent"

export interface NarratorDeps {
  fastLlm:       { complete: (body: any) => Promise<{ text: string }> }
  speakBackend:  { speak: (text: string) => Promise<void> }
  personaTone?:  string
}

export class Narrator {
  constructor(private deps: NarratorDeps) {}

  async speakAck(toolName: string): Promise<void> {
    const text = await generateAck(toolName, { llm: this.deps.fastLlm, personaTone: this.deps.personaTone })
    if (text) await this.deps.speakBackend.speak(text)
  }

  async speakTransition(toolName: string, result: any): Promise<void> {
    const text = await generateTransition(toolName, result, { llm: this.deps.fastLlm, personaTone: this.deps.personaTone })
    if (text) await this.deps.speakBackend.speak(text)
  }

  async speakFiller(): Promise<void> {
    const text = await generateFiller({ llm: this.deps.fastLlm, personaTone: this.deps.personaTone })
    if (text) await this.deps.speakBackend.speak(text)
  }

  startFillerTimer(ms: number = 5000): () => void {
    const handle = setInterval(() => { void this.speakFiller() }, ms)
    return () => clearInterval(handle)
  }
}

// src/daemon/agents/narrator.test.ts
import { test, expect } from "bun:test"
import { Narrator } from "./narrator"

test("Narrator.speakAck calls speakBackend with the generated ack", async () => {
  const spoken: string[] = []
  const n = new Narrator({
    fastLlm: { complete: async () => ({ text: "On it." }) } as any,
    speakBackend: { speak: async (t: string) => { spoken.push(t) } } as any,
  })
  await n.speakAck("gmail.list_messages")
  expect(spoken[0]).toContain("On")
})

test("Narrator.speakTransition speaks tool result summary", async () => {
  const spoken: string[] = []
  const n = new Narrator({
    fastLlm: { complete: async () => ({ text: "Found 3." }) } as any,
    speakBackend: { speak: async (t: string) => { spoken.push(t) } } as any,
  })
  await n.speakTransition("gmail.list_messages", { count: 3 })
  expect(spoken[0]).toContain("3")
})

test("Narrator filler timer emits filler if no completion within window", async () => {
  const spoken: string[] = []
  const n = new Narrator({
    fastLlm: { complete: async () => ({ text: "Still working." }) } as any,
    speakBackend: { speak: async (t: string) => { spoken.push(t) } } as any,
  })
  const stop = n.startFillerTimer(50)
  await new Promise((r) => setTimeout(r, 120))
  stop()
  expect(spoken.length).toBeGreaterThan(0)
})

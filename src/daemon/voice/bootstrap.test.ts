import { test, expect, mock } from "bun:test"
import { bootstrapVoice } from "./bootstrap"
import { Database } from "bun:sqlite"

test("bootstrapVoice returns a VoiceConductor + sidecar + sayBackend triple", async () => {
  const db = new Database(":memory:")
  const fakeLlm = { complete: async () => ({ text: "ok" }) }
  const result = await bootstrapVoice({
    db,
    helperBinary: "/nonexistent/helper",  // dry-run mode skips spawn
    dryRun: true,
    llm: fakeLlm as any,
  })
  expect(result.conductor).toBeDefined()
  expect(result.sidecar).toBeDefined()
  expect(result.sayBackend).toBeDefined()
})

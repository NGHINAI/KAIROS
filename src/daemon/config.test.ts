import { test, expect } from "bun:test"
import { loadConfig } from "./config"

test("KAIROS_WITH_VOICE env flag is parsed", () => {
  process.env.KAIROS_WITH_VOICE = "true"
  const cfg = loadConfig()
  expect(cfg.withVoice).toBe(true)
  delete process.env.KAIROS_WITH_VOICE
})

test("KAIROS_WITH_VOICE defaults to false when unset", () => {
  delete process.env.KAIROS_WITH_VOICE
  const cfg = loadConfig()
  expect(cfg.withVoice).toBe(false)
})

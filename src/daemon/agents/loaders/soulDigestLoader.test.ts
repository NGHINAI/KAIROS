// src/daemon/agents/loaders/soulDigestLoader.test.ts
import { test, expect } from "bun:test"
import { SoulDigestLoader } from "./soulDigestLoader"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

test("SoulDigestLoader returns capped digest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kairos-soul-"))
  const path = join(dir, "soul.md")
  writeFileSync(path, "Name: Nirmal\nTone: warm\nDo not interrupt during focus mode.")
  const loader = new SoulDigestLoader({ soulPath: path, maxTokens: 200 })
  const digest = await loader.load()
  expect(digest).toContain("Nirmal")
  rmSync(dir, { recursive: true })
})

test("SoulDigestLoader returns empty string when file missing", async () => {
  const loader = new SoulDigestLoader({ soulPath: "/nonexistent/soul.md", maxTokens: 200 })
  const digest = await loader.load()
  expect(digest).toBe("")
})

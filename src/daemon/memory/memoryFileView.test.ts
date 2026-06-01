// src/daemon/memory/memoryFileView.test.ts
import { describe, it, expect } from "bun:test"
import { mkdtempSync, readFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { MemoryFileView } from "./memoryFileView"

describe("MemoryFileView (Unit 5)", () => {
  it("projects live facts into per-category .md files", () => {
    const dir = mkdtempSync(join(tmpdir(), "kairos-memview-"))
    const store = {
      liveByCategory: (cat: string) => {
        if (cat === "identity") return [{ id: "1", text: "user's name is Nirmal", ts: Date.now() }]
        if (cat === "preferences") return [{ id: "2", text: "prefers terse replies", ts: Date.now() }]
        return []
      },
    }
    const view = new MemoryFileView({ semanticStore: store, dir })
    const n = view.project()
    expect(n).toBe(2) // identity + preferences (others empty, skipped)
    expect(existsSync(join(dir, "identity.md"))).toBe(true)
    expect(readFileSync(join(dir, "identity.md"), "utf8")).toMatch(/Nirmal/)
    expect(readFileSync(join(dir, "preferences.md"), "utf8")).toMatch(/terse/)
    // empty category → no file
    expect(existsSync(join(dir, "projects.md"))).toBe(false)
  })

  it("skips everything gracefully when store is empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "kairos-memview-"))
    const view = new MemoryFileView({ semanticStore: { liveByCategory: () => [] }, dir })
    expect(view.project()).toBe(0)
  })
})

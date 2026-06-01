// src/daemon/memory/memoryFileView.ts
// memU-style "memory as a file system" — a human-readable, git-friendly PROJECTION
// of the SemanticStore's live facts, one .md file per category under
// ~/.kairos/memory/. This is a READ VIEW, never the source of truth: SQLite + the
// vector index remain the query engine; these files are regenerated on each dream
// cycle so you can `cat ~/.kairos/memory/preferences.md` to inspect what KAIROS
// knows. Editing them does NOT change recall (by design — avoids split-brain).

import { homedir } from "os"
import { join } from "path"
import { mkdirSync, existsSync, writeFileSync } from "fs"

const KNOWN_CATEGORIES = ["identity", "preferences", "projects", "relationships", "knowledge", "other"]

export interface MemoryFileViewDeps {
  /** SemanticStore (Unit 1) — needs liveByCategory(category, limit). */
  semanticStore: { liveByCategory: (category: string, limit?: number) => Array<{ id: string; text: string; ts: number }> }
  dir?: string
  log?: (msg: string) => void
}

export class MemoryFileView {
  private dir: string
  constructor(private deps: MemoryFileViewDeps) {
    this.dir = deps.dir ?? join(homedir(), ".kairos", "memory")
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  /** Regenerate all category files from the current live facts. Returns the
   *  number of files written. Safe/idempotent — overwrites each file. */
  project(): number {
    let written = 0
    for (const cat of KNOWN_CATEGORIES) {
      let facts: Array<{ text: string; ts: number }> = []
      try { facts = this.deps.semanticStore.liveByCategory(cat, 500) } catch { facts = [] }
      if (facts.length === 0) continue
      const lines = facts
        .sort((a, b) => b.ts - a.ts)
        .map(f => `- ${f.text}  _(${new Date(f.ts).toISOString().slice(0, 10)})_`)
      const content = `# ${cap(cat)}\n\n_Auto-generated view of KAIROS's live memory. Source of truth is the database; edits here are not read back._\n\n${lines.join("\n")}\n`
      try { writeFileSync(join(this.dir, `${cat}.md`), content); written++ }
      catch (e) { this.deps.log?.(`[memoryFileView] write ${cat} failed: ${(e as Error).message}`) }
    }
    this.deps.log?.(`[memoryFileView] projected ${written} category file(s)`)
    return written
  }
}

function cap(s: string): string { return s.charAt(0).toUpperCase() + s.slice(1) }

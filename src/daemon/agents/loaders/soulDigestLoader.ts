// src/daemon/agents/loaders/soulDigestLoader.ts
// Reads ~/.kairos/soul.md (or configured path) and returns a token-capped digest.
// Caches the read; invalidated on file mtime change.

import { existsSync, readFileSync, statSync } from "fs"

export interface SoulDigestOpts {
  soulPath: string
  maxTokens?: number   // default 200 (rough: 4 chars/token → 800 chars)
}

export class SoulDigestLoader {
  private cached: string | undefined
  private cachedMtimeMs: number | undefined

  constructor(private opts: SoulDigestOpts) {}

  async load(): Promise<string> {
    const max = this.opts.maxTokens ?? 200
    const maxChars = max * 4

    if (!existsSync(this.opts.soulPath)) {
      this.cached = ""
      return ""
    }

    const stat = statSync(this.opts.soulPath)
    if (this.cached !== undefined && this.cachedMtimeMs === stat.mtimeMs) {
      return this.cached
    }

    const raw = readFileSync(this.opts.soulPath, "utf8")
    const capped = raw.length <= maxChars ? raw : raw.slice(0, maxChars) + "\n...(truncated)"
    this.cached = capped.trim()
    this.cachedMtimeMs = stat.mtimeMs
    return this.cached
  }
}

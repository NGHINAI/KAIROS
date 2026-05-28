// src/daemon/persona/mdLoader.ts
// Generic loader/saver for .md files with optional YAML frontmatter.

import { readFileSync, writeFileSync, existsSync, watch as fsWatch } from 'fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

export type MdFileContent = {
  frontmatter: Record<string, unknown>
  body: string
}

export const MdLoader = {
  load(path: string): MdFileContent | null {
    if (!existsSync(path)) return null
    const raw = readFileSync(path, 'utf8')
    return MdLoader.parse(raw)
  },

  parse(raw: string): MdFileContent {
    // Frontmatter: --- ... --- at very top
    const fmRe = /^---\n([\s\S]*?)\n---\n?/
    const m = raw.match(fmRe)
    if (!m) return { frontmatter: {}, body: raw }
    try {
      const fm = parseYaml(m[1]!) as Record<string, unknown>
      return { frontmatter: fm ?? {}, body: raw.slice(m[0].length) }
    } catch {
      // malformed frontmatter — treat as no frontmatter
      return { frontmatter: {}, body: raw }
    }
  },

  save(path: string, content: MdFileContent): void {
    let out = ''
    if (Object.keys(content.frontmatter).length > 0) {
      out += '---\n' + stringifyYaml(content.frontmatter).trimEnd() + '\n---\n\n'
    }
    out += content.body
    writeFileSync(path, out)
  },

  appendBody(path: string, addition: string): void {
    const existing = MdLoader.load(path)
    if (!existing) {
      writeFileSync(path, addition)
      return
    }
    MdLoader.save(path, {
      frontmatter: existing.frontmatter,
      body: existing.body + addition,
    })
  },

  watch(path: string, callback: () => void): () => void {
    const watcher = fsWatch(path, { persistent: false }, () => callback())
    return () => watcher.close()
  },
}

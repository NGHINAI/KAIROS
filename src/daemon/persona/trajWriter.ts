// src/daemon/persona/trajWriter.ts
// Appends one entry per agency action to ~/.kairos/traj/YYYY-MM-DD.md.
// Sanitizes secrets before writing. Format: YAML documents separated by ---.

import { mkdirSync, existsSync, appendFileSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { stringify as stringifyYaml, parseAllDocuments } from 'yaml'
import type { TrajEntry } from './types'

// Same SECRET_PATTERNS as C.1.5 UrgencyFloor — keep in sync.
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /xox[bpoa]-[a-zA-Z0-9-]+/g,
  /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /AKIA[A-Z0-9]{16}/g,
  /ak_[a-zA-Z0-9_-]{20,}/g,  // Composio API key pattern
]

function sanitize(text: string): string {
  let out = text
  for (const re of SECRET_PATTERNS) out = out.replace(re, '<REDACTED>')
  return out
}

export type TrajWriterOptions = {
  dir?: string                  // defaults to ~/.kairos/traj/
}

export class TrajWriter {
  private dir: string

  constructor(opts: TrajWriterOptions = {}) {
    this.dir = opts.dir ?? join(homedir(), '.kairos', 'traj')
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
  }

  record(entry: TrajEntry): void {
    const day = new Date(entry.ts).toISOString().slice(0, 10)
    const file = join(this.dir, day + '.md')

    const sanitized: TrajEntry = {
      ...entry,
      args_summary: sanitize(entry.args_summary),
      steps: entry.steps.map(s => ({
        ...s,
        result_summary: sanitize(s.result_summary),
        observation: s.observation ? sanitize(s.observation) : undefined,
        reasoning: s.reasoning ? sanitize(s.reasoning) : undefined,
      })),
    }

    const block = '---\n' + stringifyYaml(sanitized).trimEnd() + '\n---\n'
    appendFileSync(file, block)
  }

  listDays(): string[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map(f => f.replace(/\.md$/, ''))
      .sort()
  }

  readDay(day: string): TrajEntry[] {
    const file = join(this.dir, day + '.md')
    if (!existsSync(file)) return []
    const raw = readFileSync(file, 'utf8')
    try {
      const docs = parseAllDocuments(raw)
      return docs.map(d => d.toJSON()).filter(Boolean) as TrajEntry[]
    } catch {
      return []
    }
  }
}

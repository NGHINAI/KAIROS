// src/daemon/persona/personaUpdater.ts
// Manages ~/.kairos/persona.md. Enforces Hermes-style ≤500 token cap.
//
// Two write paths:
//   - applyDreamingDiff() — called by Task 6's 3-phase Dreaming with consolidated diff
//   - recordNudge()       — called inline when user says "remember I prefer X"
//
// Both paths are persisted to persona.md via MdLoader and surface PersonaFile to readers.

import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import { MdLoader } from './mdLoader'
import type { PersonaFile } from './types'

const DEFAULT_TOKEN_CAP = 400   // Conservative under 500 (25% buffer for BPE variance)

/** Rough token count via chars/4 heuristic. Same heuristic as C.2.6 PromptAssembler. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export type PersonaSectionKey = 'working_patterns' | 'communication_style' | 'preferences' | 'recent_themes' | 'notes'

export type PersonaUpdaterOptions = {
  path?: string                    // defaults to ~/.kairos/persona.md
  tokenCap?: number                // defaults to 400 tokens
}

export type PersonaDiff = Partial<Pick<PersonaFile,
  'working_patterns' | 'communication_style' | 'preferences' | 'recent_themes' | 'notes'>>

export class PersonaUpdater {
  private path: string
  private tokenCap: number

  constructor(opts: PersonaUpdaterOptions = {}) {
    this.path = opts.path ?? join(homedir(), '.kairos', 'persona.md')
    this.tokenCap = opts.tokenCap ?? DEFAULT_TOKEN_CAP
  }

  /** Load current persona — returns a never-null PersonaFile (empty if file missing). */
  get(): PersonaFile {
    const f = MdLoader.load(this.path)
    if (!f) return this.emptyPersona()
    const fm = f.frontmatter as any
    return {
      version: Number(fm.version ?? 1),
      last_updated_at: Number(fm.last_updated_at ?? 0),
      working_patterns: typeof fm.working_patterns === 'string' ? fm.working_patterns : undefined,
      communication_style: typeof fm.communication_style === 'string' ? fm.communication_style : undefined,
      preferences: typeof fm.preferences === 'string' ? fm.preferences : undefined,
      recent_themes: typeof fm.recent_themes === 'string' ? fm.recent_themes : undefined,
      notes: typeof fm.notes === 'string' ? fm.notes : undefined,
    }
  }

  /** Apply a Dreaming-produced diff. Merges fields; replaces (does not append). Enforces token cap. */
  applyDreamingDiff(diff: PersonaDiff): PersonaFile {
    const current = this.get()
    const merged: PersonaFile = {
      ...current,
      ...diff,
      version: current.version,
      last_updated_at: Date.now(),
    }
    return this.persistEnforcingCap(merged)
  }

  /** Inline user nudge: e.g., "remember I prefer voice over text".
   *  Appends to `notes` section. Capped section by cap. */
  recordNudge(nudge: string): PersonaFile {
    if (!nudge.trim()) return this.get()
    const current = this.get()
    const existing = current.notes ?? ''
    const updated = (existing ? existing + '\n' : '') + `- ${nudge.trim()}`
    const merged: PersonaFile = {
      ...current,
      notes: updated,
      last_updated_at: Date.now(),
    }
    return this.persistEnforcingCap(merged)
  }

  /** Total token estimate across all populated sections (sum of values). */
  estimateCurrentTokens(): number {
    const p = this.get()
    const all = [p.working_patterns, p.communication_style, p.preferences, p.recent_themes, p.notes]
      .filter(Boolean).join('\n')
    return estimateTokens(all)
  }

  /** Persist + enforce token cap. If over cap, drops trailing notes lines first, then oldest fields. */
  private persistEnforcingCap(persona: PersonaFile): PersonaFile {
    let final = { ...persona }
    let attempts = 0
    while (this.personaTokens(final) > this.tokenCap && attempts < 10) {
      attempts++
      // Strategy: trim notes oldest-first (assumes notes are append-only), then drop fields by priority.
      if (final.notes && final.notes.length > 0) {
        const lines = final.notes.split('\n')
        if (lines.length > 1) {
          final.notes = lines.slice(1).join('\n')   // drop oldest line
          continue
        }
        final.notes = undefined
        continue
      }
      // Drop low-priority fields first: recent_themes, preferences, communication_style, working_patterns
      if (final.recent_themes) { final.recent_themes = undefined; continue }
      if (final.preferences) { final.preferences = undefined; continue }
      if (final.communication_style) { final.communication_style = undefined; continue }
      if (final.working_patterns) { final.working_patterns = undefined; continue }
      break
    }

    const dir = dirname(this.path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const fm: Record<string, unknown> = {
      version: final.version,
      last_updated_at: final.last_updated_at,
    }
    if (final.working_patterns) fm.working_patterns = final.working_patterns
    if (final.communication_style) fm.communication_style = final.communication_style
    if (final.preferences) fm.preferences = final.preferences
    if (final.recent_themes) fm.recent_themes = final.recent_themes
    if (final.notes) fm.notes = final.notes

    MdLoader.save(this.path, { frontmatter: fm, body: '' })
    return final
  }

  private personaTokens(p: PersonaFile): number {
    const all = [p.working_patterns, p.communication_style, p.preferences, p.recent_themes, p.notes]
      .filter(Boolean).join('\n')
    return estimateTokens(all)
  }

  private emptyPersona(): PersonaFile {
    return { version: 1, last_updated_at: 0 }
  }
}

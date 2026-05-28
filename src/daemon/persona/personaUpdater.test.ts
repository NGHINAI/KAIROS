import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PersonaUpdater } from './personaUpdater'

describe('PersonaUpdater', () => {
  let tmp: string
  let path: string
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-persona-'))
    path = join(tmp, 'persona.md')
  })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('returns empty persona when file does not exist', () => {
    const u = new PersonaUpdater({ path })
    const p = u.get()
    expect(p.version).toBe(1)
    expect(p.working_patterns).toBeUndefined()
  })

  it('applyDreamingDiff persists fields and updates last_updated_at', () => {
    const u = new PersonaUpdater({ path })
    const p = u.applyDreamingDiff({
      working_patterns: 'Active 09:30-18:00 weekdays',
      communication_style: 'Terse, no sugarcoating',
    })
    expect(p.working_patterns).toContain('Active')
    expect(p.last_updated_at).toBeGreaterThan(0)
    // Round-trip via file:
    const u2 = new PersonaUpdater({ path })
    const reloaded = u2.get()
    expect(reloaded.communication_style).toBe('Terse, no sugarcoating')
  })

  it('recordNudge appends to notes (oldest first preserved order — newest at bottom)', () => {
    const u = new PersonaUpdater({ path })
    u.recordNudge('prefers voice over text')
    u.recordNudge('hates morning standups')
    const p = u.get()
    expect(p.notes).toContain('voice over text')
    expect(p.notes).toContain('morning standups')
    // Order: voice line first, standups line second
    const idx_voice = p.notes!.indexOf('voice')
    const idx_standups = p.notes!.indexOf('standups')
    expect(idx_voice).toBeLessThan(idx_standups)
  })

  it('enforces token cap by dropping oldest notes lines', () => {
    const u = new PersonaUpdater({ path, tokenCap: 30 })   // very tight cap for test
    // Each nudge is ~10 tokens worth of text. Recording 10 should force drops.
    for (let i = 0; i < 10; i++) {
      u.recordNudge(`some nudge text number ${i} that fills space`)
    }
    expect(u.estimateCurrentTokens()).toBeLessThanOrEqual(40)   // allow 33% buffer
    // The latest nudge should still be present
    const p = u.get()
    expect(p.notes ?? '').toContain('9')
  })

  it('enforces token cap by dropping field priority (notes → themes → preferences ...)', () => {
    const u = new PersonaUpdater({ path, tokenCap: 20 })
    const longText = 'x'.repeat(200)
    u.applyDreamingDiff({
      working_patterns: longText, communication_style: longText,
      preferences: longText, recent_themes: longText, notes: longText,
    })
    const final = u.get()
    // At least working_patterns or communication_style should survive (highest priority); notes should be gone
    expect(final.notes).toBeUndefined()
  })

  it('empty nudge does not change persona', () => {
    const u = new PersonaUpdater({ path })
    u.applyDreamingDiff({ preferences: 'A' })
    const before = u.get()
    u.recordNudge('')
    u.recordNudge('   ')
    const after = u.get()
    expect(after.preferences).toBe(before.preferences)
  })
})

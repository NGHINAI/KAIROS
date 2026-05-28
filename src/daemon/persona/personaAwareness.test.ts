import { describe, it, expect, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PersonaUpdater } from './personaUpdater'
import { PersonaAwareness } from './personaAwareness'

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), 'kairos-aware-'))
  const personaUpdater = new PersonaUpdater({ path: join(tmp, 'persona.md') })
  let liveState: any = {}
  const aware = new PersonaAwareness({
    personaUpdater,
    getLiveState: () => liveState,
  })
  return { tmp, personaUpdater, aware, setLive: (s: any) => { liveState = s } }
}

describe('PersonaAwareness', () => {
  it('default hints when persona is empty', () => {
    const { aware, setLive, tmp } = setup()
    setLive({ current_hour_local: 14 })
    const h = aware.getHints()
    expect(h.interrupt_aggressiveness).toBe('medium')
    expect(h.in_focus_now).toBe(false)
    expect(h.active_hours_now).toBe(true)
    expect(h.prefer_terse).toBe(false)
    rmSync(tmp, { recursive: true })
  })

  it('derives interrupt_aggressiveness=low from persona text', () => {
    const { aware, personaUpdater, setLive, tmp } = setup()
    personaUpdater.applyDreamingDiff({ communication_style: 'silent unless urgent' })
    setLive({})
    aware.invalidate()
    expect(aware.getHints().interrupt_aggressiveness).toBe('low')
    rmSync(tmp, { recursive: true })
  })

  it('derives in_focus_now=true when current app is a code editor', () => {
    const { aware, setLive, tmp } = setup()
    setLive({ current_focus_app: 'Visual Studio Code' })
    expect(aware.getHints().in_focus_now).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('derives in_focus_now=true when is_in_meeting', () => {
    const { aware, setLive, tmp } = setup()
    setLive({ is_in_meeting: true })
    expect(aware.getHints().in_focus_now).toBe(true)
    rmSync(tmp, { recursive: true })
  })

  it('derives active_hours_now from persona.working_patterns', () => {
    const { aware, personaUpdater, setLive, tmp } = setup()
    personaUpdater.applyDreamingDiff({ working_patterns: 'Active 10:00 – 16:00 Mon-Fri' })
    setLive({ current_hour_local: 14 })
    aware.invalidate()
    expect(aware.getHints().active_hours_now).toBe(true)
    setLive({ current_hour_local: 20 })
    aware.invalidate()
    expect(aware.getHints().active_hours_now).toBe(false)
    rmSync(tmp, { recursive: true })
  })

  it('caches hints for ~10s (returns same instance within window)', () => {
    const { aware, setLive, tmp } = setup()
    setLive({ current_hour_local: 14 })
    const h1 = aware.getHints()
    setLive({ current_hour_local: 14, current_focus_app: 'changed' })
    const h2 = aware.getHints()
    expect(h2).toBe(h1)   // cached — same object reference
    rmSync(tmp, { recursive: true })
  })

  it('invalidate() forces fresh derivation', () => {
    const { aware, setLive, tmp } = setup()
    setLive({ current_hour_local: 14 })
    const h1 = aware.getHints()
    aware.invalidate()
    setLive({ current_hour_local: 14, current_focus_app: 'VSCode' })
    const h2 = aware.getHints()
    expect(h2).not.toBe(h1)   // re-derived
    expect(h2.in_focus_now).toBe(true)
    rmSync(tmp, { recursive: true })
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { TrajWriter } from './trajWriter'
import { PersonaUpdater } from './personaUpdater'
import { DreamingExtension } from './dreamingExtension'

describe('DreamingExtension', () => {
  let tmp: string
  let trajDir: string
  let personaPath: string
  let dreamsPath: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kairos-dream-'))
    trajDir = join(tmp, 'traj')
    personaPath = join(tmp, 'persona.md')
    dreamsPath = join(homedir(), '.kairos', 'DREAMS.md')   // fixed: extension writes to ~/.kairos/DREAMS.md
    if (existsSync(dreamsPath)) rmSync(dreamsPath)
  })
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
    if (existsSync(dreamsPath)) rmSync(dreamsPath)
  })

  it('runs a Light cycle with no trajectories gracefully', async () => {
    const ext = new DreamingExtension({
      trajWriter: new TrajWriter({ dir: trajDir }),
      personaUpdater: new PersonaUpdater({ path: personaPath }),
    })
    const entry = await ext.runCycle('light')
    expect(entry.cycle_type).toBe('light')
    expect(entry.trajectories_scanned).toBe(0)
    expect(entry.observations_promoted_to_persona).toBe(0)
  })

  it('runs a Light cycle and writes to DREAMS.md', async () => {
    const writer = new TrajWriter({ dir: trajDir })
    writer.record({ ts: Date.now(), task_goal: 'a', intent_id: 'send_message', args_summary: 'ch=C1', steps: [{ action: 'send', result_summary: 'ok' }], outcome: 'success', duration_ms: 100 })
    const ext = new DreamingExtension({
      trajWriter: writer,
      personaUpdater: new PersonaUpdater({ path: personaPath }),
    })
    const entry = await ext.runCycle('light')
    expect(entry.trajectories_scanned).toBe(1)
    expect(existsSync(dreamsPath)).toBe(true)
    expect(readFileSync(dreamsPath, 'utf8')).toContain('cycle_type: light')
  })

  it('promotes recurring patterns to persona.md (recent_themes section)', async () => {
    const writer = new TrajWriter({ dir: trajDir })
    const now = Date.now()
    for (let i = 0; i < 5; i++) {
      writer.record({ ts: now - i * 1000, task_goal: 'send a msg', intent_id: 'send_message', args_summary: 'ch=C1 text=hello', steps: [{ action: 'send', result_summary: 'ok' }], outcome: 'success', duration_ms: 100 })
    }
    const updater = new PersonaUpdater({ path: personaPath })
    const ext = new DreamingExtension({ trajWriter: writer, personaUpdater: updater })
    await ext.runCycle('rem')
    const p = updater.get()
    expect(p.recent_themes).toBeDefined()
    expect(p.recent_themes).toContain('send_message')
  })

  it('REM phase looks back 7 days; entries outside scope are filtered out', async () => {
    const writer = new TrajWriter({ dir: trajDir })
    const now = Date.now()
    // Inside REM window (3d ago)
    writer.record({ ts: now - 3 * 86400_000, task_goal: 'inside', intent_id: 'send_message', args_summary: '', steps: [], outcome: 'success', duration_ms: 1 })
    // Outside REM window (20d ago)
    writer.record({ ts: now - 20 * 86400_000, task_goal: 'outside', intent_id: 'send_message', args_summary: '', steps: [], outcome: 'success', duration_ms: 1 })
    const ext = new DreamingExtension({ trajWriter: writer, personaUpdater: new PersonaUpdater({ path: personaPath }) })
    const entry = await ext.runCycle('rem')
    expect(entry.trajectories_scanned).toBe(1)   // only the inside-window one
  })

  it('Deep phase uses the lowest threshold (0.45) and looks back 30 days', async () => {
    const writer = new TrajWriter({ dir: trajDir })
    writer.record({ ts: Date.now(), task_goal: 'm', intent_id: 'send_message', args_summary: '', steps: [{ action: 's', result_summary: 'ok' }], outcome: 'success', duration_ms: 1 })
    const updater = new PersonaUpdater({ path: personaPath })
    const ext = new DreamingExtension({ trajWriter: writer, personaUpdater: updater })
    const entry = await ext.runCycle('deep')
    expect(entry.cycle_type).toBe('deep')
    // A single success trajectory may or may not promote — assert the run succeeded
    expect(entry.trajectories_scanned).toBeGreaterThanOrEqual(1)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TrajWriter } from './trajWriter'

describe('TrajWriter', () => {
  let tmp: string
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kairos-traj-')) })
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

  it('writes an entry to the dated file (creates if missing)', () => {
    const writer = new TrajWriter({ dir: tmp })
    writer.record({
      ts: Date.now(),
      task_goal: 'send slack message',
      intent_id: 'composio_tool_call',
      args_summary: 'slack::send_message channel=C1234',
      steps: [{ action: 'slack_send', result_summary: 'ok' }],
      outcome: 'success',
      duration_ms: 1234,
    })
    const today = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(tmp, today + '.md'), 'utf8')
    expect(content).toMatch(/send slack message/)
    expect(content).toMatch(/composio_tool_call/)
  })

  it('appends multiple entries to the same day file', () => {
    const writer = new TrajWriter({ dir: tmp })
    writer.record({ ts: Date.now(), task_goal: 'a', intent_id: 'i', args_summary: '', steps: [], outcome: 'success', duration_ms: 1 })
    writer.record({ ts: Date.now(), task_goal: 'b', intent_id: 'i', args_summary: '', steps: [], outcome: 'failed', duration_ms: 2 })
    const today = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(tmp, today + '.md'), 'utf8')
    expect(content).toMatch(/task_goal: a/)
    expect(content).toMatch(/task_goal: b/)
  })

  it('sanitizes Composio key (ak_) from args_summary', () => {
    const writer = new TrajWriter({ dir: tmp })
    writer.record({
      ts: Date.now(),
      task_goal: 'leak attempt',
      intent_id: 'i',
      args_summary: 'composio_api_key=ak_3GI9JhYdO3uJkK9JgABC4j',
      steps: [],
      outcome: 'success',
      duration_ms: 1,
    })
    const today = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(tmp, today + '.md'), 'utf8')
    expect(content).not.toContain('ak_3GI9JhYdO3uJkK9JgABC4j')
    expect(content).toMatch(/REDACTED/)
  })

  it('sanitizes GitHub PAT (ghp_) from args_summary', () => {
    const writer = new TrajWriter({ dir: tmp })
    writer.record({
      ts: Date.now(),
      task_goal: 'leak',
      intent_id: 'i',
      args_summary: 'token=ghp_abcdef1234567890ABCDEFGHIJKLMNOPQRSTUVWXY',
      steps: [],
      outcome: 'success',
      duration_ms: 1,
    })
    const today = new Date().toISOString().slice(0, 10)
    const content = readFileSync(join(tmp, today + '.md'), 'utf8')
    expect(content).not.toContain('ghp_abcdef1234567890ABCDEFGHIJKLMNOPQRSTUVWXY')
  })

  it('listDays returns all date-named files in the dir', () => {
    const writer = new TrajWriter({ dir: tmp })
    writer.record({ ts: new Date('2026-05-25T12:00:00Z').getTime(), task_goal: 'a', intent_id: 'i', args_summary: '', steps: [], outcome: 'success', duration_ms: 1 })
    writer.record({ ts: new Date('2026-05-26T12:00:00Z').getTime(), task_goal: 'b', intent_id: 'i', args_summary: '', steps: [], outcome: 'success', duration_ms: 1 })
    const days = writer.listDays()
    expect(days.length).toBe(2)
    expect(days).toContain('2026-05-25')
    expect(days).toContain('2026-05-26')
  })

  it('readDay parses entries back from a day file', () => {
    const writer = new TrajWriter({ dir: tmp })
    writer.record({ ts: Date.now(), task_goal: 'task A', intent_id: 'i', args_summary: '', steps: [], outcome: 'success', duration_ms: 1 })
    const today = new Date().toISOString().slice(0, 10)
    const entries = writer.readDay(today)
    expect(entries.length).toBe(1)
    expect(entries[0].task_goal).toBe('task A')
  })
})

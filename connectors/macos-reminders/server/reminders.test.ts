import { describe, it, expect } from 'bun:test'
import { listReminders, addReminder, completeReminder } from './reminders'

describe('macOS reminders (via osascript)', () => {
  it('listReminders calls osascript and parses output', async () => {
    let cmd: string[] = []
    const result = await listReminders({
      probe: async (c) => { cmd = c; return { ok: true, stdout: 'Buy milk||2026-05-26\nCall mom||(no date)', stderr: '' } },
    })
    expect(cmd[0]).toBe('osascript')
    expect(result.length).toBe(2)
    expect(result[0]?.title).toBe('Buy milk')
    expect(result[0]?.due).toBe('2026-05-26')
    expect(result[1]?.due).toBeNull()
  })

  it('addReminder builds correct AppleScript with title only', async () => {
    let cmd: string[] = []
    await addReminder('Drink water', null, { probe: async (c) => { cmd = c; return { ok: true, stdout: '', stderr: '' } } })
    expect(cmd.join(' ')).toContain('make new reminder')
    expect(cmd.join(' ')).toContain('Drink water')
  })

  it('addReminder with due date includes the date in script', async () => {
    let cmd: string[] = []
    await addReminder('Standup', '2026-05-26T09:00:00Z', { probe: async (c) => { cmd = c; return { ok: true, stdout: '', stderr: '' } } })
    expect(cmd.join(' ')).toContain('2026')
  })

  it('completeReminder finds by title and marks completed', async () => {
    let cmd: string[] = []
    await completeReminder('Buy milk', { probe: async (c) => { cmd = c; return { ok: true, stdout: '', stderr: '' } } })
    expect(cmd.join(' ')).toContain('completed')
    expect(cmd.join(' ')).toContain('Buy milk')
  })
})

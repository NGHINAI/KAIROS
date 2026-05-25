// AppleScript wrappers for macOS Reminders.app.
// No third-party API; works on any Mac with Reminders enabled.

type ProbeResult = { ok: boolean; stdout: string; stderr: string }
type Probe = (cmd: string[]) => Promise<ProbeResult>

export type ReminderItem = {
  title: string
  due: string | null
}

const defaultProbe: Probe = async (cmd) => {
  const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  return {
    ok: code === 0,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  }
}

const escapeAppleScript = (s: string) => s.replace(/"/g, '\\"')

export async function listReminders(opts: { probe?: Probe } = {}): Promise<ReminderItem[]> {
  const probe = opts.probe ?? defaultProbe
  const script = `
    tell application "Reminders"
      set output to ""
      repeat with r in reminders of default list whose completed is false
        try
          set d to short date string of (due date of r)
        on error
          set d to "(no date)"
        end try
        set output to output & (name of r) & "||" & d & "\n"
      end repeat
      return output
    end tell
  `
  const result = await probe(['osascript', '-e', script])
  if (!result.ok) return []
  return result.stdout
    .split('\n')
    .filter(l => l.includes('||'))
    .map(l => {
      const [title, due] = l.split('||').map(s => s.trim())
      return { title: title!, due: due === '(no date)' ? null : due! }
    })
}

export async function addReminder(title: string, dueIso: string | null, opts: { probe?: Probe } = {}): Promise<void> {
  const probe = opts.probe ?? defaultProbe
  const dueClause = dueIso ? `, due date:(date "${dueIso}")` : ''
  const script = `
    tell application "Reminders"
      tell default list
        make new reminder with properties {name:"${escapeAppleScript(title)}"${dueClause}}
      end tell
    end tell
  `
  const result = await probe(['osascript', '-e', script])
  if (!result.ok) throw new Error(`addReminder failed: ${result.stderr.slice(0, 200)}`)
}

export async function completeReminder(title: string, opts: { probe?: Probe } = {}): Promise<void> {
  const probe = opts.probe ?? defaultProbe
  const script = `
    tell application "Reminders"
      set found to (reminders of default list whose name is "${escapeAppleScript(title)}")
      if (count of found) > 0 then
        set completed of item 1 of found to true
      end if
    end tell
  `
  const result = await probe(['osascript', '-e', script])
  if (!result.ok) throw new Error(`completeReminder failed: ${result.stderr.slice(0, 200)}`)
}

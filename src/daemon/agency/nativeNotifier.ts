// macOS native notification via osascript. Best-effort — never throws.
// If notification fails, the inbox surface still has the record.

import { logError } from '../logger'

type Probe = (args: { title: string; body: string }) => Promise<void>

export type NotifyArgs = {
  title: string
  body: string
  urgency?: 'low' | 'normal' | 'high'
}

export type NativeNotifierOptions = {
  probe?: Probe
}

export class NativeNotifier {
  private probe: Probe

  constructor(opts?: NativeNotifierOptions) {
    this.probe = opts?.probe ?? defaultProbe
  }

  async notify(args: NotifyArgs): Promise<void> {
    try {
      await this.probe({ title: args.title, body: args.body })
    } catch (err) {
      logError('NativeNotifier: failed', err)
    }
  }
}

/**
 * Escape a string for safe interpolation into an AppleScript double-quoted
 * string literal. AppleScript delimits strings with `"`, so we must:
 *   \  →  \\   (must escape backslashes first)
 *   "  →  \"
 *   newlines → spaces (AppleScript literals don't support \n)
 * Exported for direct testing — caller composes the full script.
 */
export function escapeForAppleScript(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ')
}

async function defaultProbe(args: { title: string; body: string }): Promise<void> {
  const script = `display notification "${escapeForAppleScript(args.body)}" with title "${escapeForAppleScript(args.title)}" sound name "Submarine"`
  const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`osascript exited ${code}: ${err.slice(0, 200)}`)
  }
}

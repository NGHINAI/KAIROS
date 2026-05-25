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

async function defaultProbe(args: { title: string; body: string }): Promise<void> {
  const esc = (s: string): string => s.replace(/'/g, "'\\''")
  const script = `display notification "${esc(args.body)}" with title "${esc(args.title)}" sound name "Submarine"`
  const proc = Bun.spawn(['osascript', '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const code = await proc.exited
  if (code !== 0) {
    const err = await new Response(proc.stderr).text()
    throw new Error(`osascript exited ${code}: ${err.slice(0, 200)}`)
  }
}

// src/daemon/restraint/focusDetector.ts
// Detects user availability/focus state for the restraint layer.
//
// Sources:
//   - Focused app + duration: from Phase A's focus-app observer (poll latest state)
//   - Meeting status: from Phase A's calendar-local observer (look for active event)
//   - Quiet hours: from config (default 10pm-7am)
//   - Manual pause: in-memory, set via pauseUntil()
//
// shouldSuppress(urgent) is the master "is this a bad time?" check.
// Urgent override bypasses everything except an explicit manual pause.

import type { FocusState, RestraintConfig } from './types'

type FocusedAppProbe = () => Promise<{ app: string; duration_sec: number }>
type MeetingProbe = () => Promise<boolean>
type NowFn = () => number

export type FocusDetectorOptions = {
  now?: NowFn
  probeFocusedApp?: FocusedAppProbe
  probeMeeting?: MeetingProbe
}

export class FocusDetector {
  private now: NowFn
  private probeFocusedApp: FocusedAppProbe
  private probeMeeting: MeetingProbe
  private pauseUntilMs: number | null = null

  constructor(private config: RestraintConfig, opts?: FocusDetectorOptions) {
    this.now = opts?.now ?? Date.now
    this.probeFocusedApp = opts?.probeFocusedApp ?? defaultFocusedAppProbe
    this.probeMeeting = opts?.probeMeeting ?? defaultMeetingProbe
  }

  async state(): Promise<FocusState> {
    const [appInfo, meeting] = await Promise.all([
      this.probeFocusedApp().catch(() => ({ app: null as any, duration_sec: 0 })),
      this.probeMeeting().catch(() => false),
    ])
    return {
      current_app: appInfo.app || null,
      app_duration_sec: appInfo.duration_sec,
      in_deep_focus: appInfo.duration_sec >= this.config.deep_focus_threshold_sec,
      in_meeting: meeting,
      in_quiet_hours: this.isQuietHours(),
      pause_until: this.pauseUntilMs && this.pauseUntilMs > this.now() ? this.pauseUntilMs : null,
    }
  }

  /** Returns true if we should suppress non-urgent notifications now. */
  async shouldSuppress(opts: { urgent: boolean }): Promise<boolean> {
    const s = await this.state()
    if (s.pause_until) return true                       // manual pause always wins
    if (opts.urgent) return false                        // urgent bypasses all
    return s.in_deep_focus || s.in_meeting || s.in_quiet_hours
  }

  pauseUntil(timestampMs: number): void {
    this.pauseUntilMs = timestampMs
  }

  clearPause(): void {
    this.pauseUntilMs = null
  }

  private isQuietHours(): boolean {
    const d = new Date(this.now())
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const start = this.config.quiet_hours_start
    const end = this.config.quiet_hours_end
    if (start <= end) {
      return hhmm >= start && hhmm < end
    } else {
      return hhmm >= start || hhmm < end   // wraps midnight (e.g. 22:00 → 07:00)
    }
  }
}

async function defaultFocusedAppProbe(): Promise<{ app: string; duration_sec: number }> {
  // Default: shell osascript to read frontmost app. Duration is not directly available
  // from osascript — caller (RestraintPipeline) should provide a probe backed by Phase A's
  // focus-app observer which tracks per-app durations.
  const proc = Bun.spawn(['osascript', '-e',
    'tell application "System Events" to return name of first application process whose frontmost is true'],
    { stdout: 'pipe' })
  await proc.exited
  const app = (await new Response(proc.stdout).text()).trim()
  return { app, duration_sec: 0 }
}

async function defaultMeetingProbe(): Promise<boolean> {
  // Default: false. Real probe should query Phase A's calendar-local observer.
  return false
}

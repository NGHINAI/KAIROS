// KAIROS notification system — now routes to Discord instead of macOS.
//
// Webhook-only (send): all alerts go to your Discord channel via webhook.
// For replies: user reads the Discord message, then types in Claude Code
// (e.g., "kairos approve abc-123"). Future enhancement: Discord bot for
// true bidirectional chat.
//
// Same function signatures as before so the rest of the codebase doesn't
// need to change.

import type { Database } from 'bun:sqlite'
import { log } from './logger'
import { postToDiscord, type DiscordSeverity } from './discord'

// Sandbox dir is needed to find secrets.json — set once at startup
let _sandboxDir: string = process.cwd()
export function setSandboxDir(dir: string): void {
  _sandboxDir = dir
}

// ─── Fire-and-forget banner (now → Discord post) ─────────────────────

/**
 * Send a basic notification. Goes to Discord channel.
 * No interaction possible — purely informational.
 */
export function sendMacNotification(
  title: string,
  message: string,
  subtitle?: string,
): void {
  const fullTitle = subtitle ? `${title} — ${subtitle}` : title
  void postToDiscord({
    sandboxDir: _sandboxDir,
    title: fullTitle,
    body: message,
    severity: 'info',
  })
}

// ─── Interactive notification (now → Discord with instructions) ──────

/**
 * Send a notification that needs user response. Posts to Discord with
 * instructions on how to respond (via Claude Code or kairos CLI).
 * The "spawn" pattern is gone — Discord posts are non-blocking by nature.
 */
export function sendInteractiveNotification(opts: {
  title: string
  message: string
  observationId?: string
  buttons?: string[]
  showTextField?: boolean
  db: Database
  triggerTick?: (event: { source: string; reason: string }) => void
}): void {
  const buttons = opts.buttons ?? ['Act on it', 'Dismiss', 'Later']

  // Build response instructions for the user
  const instructions = opts.observationId
    ? [
        '',
        '**How to respond:**',
        `\`kairos act ${opts.observationId}\` — do it now`,
        `\`kairos dismiss ${opts.observationId}\` — ignore (KAIROS will learn)`,
        `Or just send any free-text reply in Claude Code to make it a custom task.`,
      ].join('\n')
    : ''

  void postToDiscord({
    sandboxDir: _sandboxDir,
    title: opts.title,
    body: opts.message + instructions,
    severity: 'urgent',
    fields: opts.observationId
      ? [{ name: 'Observation ID', value: opts.observationId, inline: true }]
      : undefined,
  })
}

// ─── Smart notification: picks severity color, adds CLI hints ────────

/**
 * Send observation notification. Routes to Discord with severity-appropriate
 * styling:
 *   - critical → red embed, includes act/dismiss instructions
 *   - warning  → orange embed, lighter notification
 *   - info     → nothing (only visible via kairos_observe tool)
 */
export function sendObservationNotification(opts: {
  severity: string
  message: string
  observationId: string
  category: string
  db: Database
  triggerTick?: (event: { source: string; reason: string }) => void
}): void {
  if (opts.severity === 'critical') {
    sendInteractiveNotification({
      title: 'KAIROS — needs attention',
      message: opts.message,
      observationId: opts.observationId,
      db: opts.db,
      triggerTick: opts.triggerTick,
    })
  } else if (opts.severity === 'warning') {
    void postToDiscord({
      sandboxDir: _sandboxDir,
      title: `KAIROS — ${opts.category}`,
      body: opts.message + `\n\n→ \`kairos act ${opts.observationId}\` to handle it`,
      severity: 'warning',
      fields: [
        { name: 'Observation ID', value: opts.observationId, inline: true },
        { name: 'Category', value: opts.category, inline: true },
      ],
    })
  }
  // info: no notification (check via kairos_observe)
}

// ─── Helper: notify a task result with Discord-formatted embed ───────

export function notifyTaskResult(opts: {
  taskId: string
  description: string
  status: 'success' | 'failed' | 'blocked'
  summary: string
  diffPath?: string
}): void {
  const severityMap: Record<string, DiscordSeverity> = {
    success: 'success',
    failed: 'error',
    blocked: 'urgent',
  }
  const titlePrefix: Record<string, string> = {
    success: '✓ Task done',
    failed: '✗ Task failed',
    blocked: '🛡️ Task blocked',
  }

  void postToDiscord({
    sandboxDir: _sandboxDir,
    title: `${titlePrefix[opts.status]} — ${opts.description.slice(0, 60)}`,
    body: opts.summary.slice(0, 3500),
    severity: severityMap[opts.status]!,
    fields: [
      { name: 'Task ID', value: opts.taskId, inline: true },
      ...(opts.diffPath ? [{ name: 'Diff', value: opts.diffPath, inline: true }] : []),
    ],
  })
}

// ─── Helper: notify a scheduled task is firing ───────────────────────

export function notifyScheduleFired(opts: {
  scheduleId: string
  description: string
}): void {
  void postToDiscord({
    sandboxDir: _sandboxDir,
    title: '⏰ Scheduled task firing',
    body: opts.description.slice(0, 500),
    severity: 'info',
    fields: [{ name: 'Schedule', value: opts.scheduleId, inline: true }],
  })
}

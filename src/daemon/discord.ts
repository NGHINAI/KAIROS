// Discord webhook notifier.
// Replaces macOS notifications with Discord channel posts.
// Reads webhook URL from state/secrets.json or KAIROS_DISCORD_WEBHOOK env var.

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { log, logError } from './logger'

let cachedWebhookUrl: string | null | undefined = undefined

function getWebhookUrl(sandboxDir: string): string | null {
  // Cache: only read once
  if (cachedWebhookUrl !== undefined) return cachedWebhookUrl

  // Env var takes precedence
  const fromEnv = process.env.KAIROS_DISCORD_WEBHOOK
  if (fromEnv) {
    cachedWebhookUrl = fromEnv
    return fromEnv
  }

  // Fall back to state/secrets.json
  const secretsPath = join(sandboxDir, 'state', 'secrets.json')
  if (existsSync(secretsPath)) {
    try {
      const secrets = JSON.parse(readFileSync(secretsPath, 'utf8')) as { discord_webhook?: string }
      cachedWebhookUrl = secrets.discord_webhook || null
      return cachedWebhookUrl
    } catch {
      cachedWebhookUrl = null
    }
  }

  cachedWebhookUrl = null
  return null
}

export type DiscordSeverity = 'info' | 'success' | 'warning' | 'urgent' | 'error'

const SEVERITY_COLORS: Record<DiscordSeverity, number> = {
  info:    0x3498db, // blue
  success: 0x2ecc71, // green
  warning: 0xf39c12, // orange
  urgent:  0xe74c3c, // red
  error:   0x95a5a6, // grey (errors are different from urgent — failures, not alerts)
}

const SEVERITY_EMOJI: Record<DiscordSeverity, string> = {
  info:    'ℹ️',
  success: '✓',
  warning: '⚠️',
  urgent:  '🔔',
  error:   '✗',
}

/**
 * Post a message to Discord. Non-blocking — fires and forgets.
 * Returns true if the post succeeded, false otherwise.
 */
export async function postToDiscord(opts: {
  sandboxDir: string
  title: string
  body: string
  severity?: DiscordSeverity
  fields?: Array<{ name: string; value: string; inline?: boolean }>
  footer?: string
  url?: string  // Optional clickable link
}): Promise<boolean> {
  const webhook = getWebhookUrl(opts.sandboxDir)
  if (!webhook) {
    log('Discord webhook not configured — skipping notification', 'warn')
    return false
  }

  const severity = opts.severity ?? 'info'
  const emoji = SEVERITY_EMOJI[severity]

  // Discord embed has limits: title 256, description 4096, field value 1024, total 6000
  const embed = {
    title: `${emoji} ${opts.title}`.slice(0, 256),
    description: opts.body.slice(0, 4000),
    color: SEVERITY_COLORS[severity],
    timestamp: new Date().toISOString(),
    footer: {
      text: opts.footer ?? `KAIROS · ${severity}`,
    },
    ...(opts.fields && opts.fields.length > 0 && {
      fields: opts.fields.slice(0, 10).map(f => ({
        name: f.name.slice(0, 256),
        value: f.value.slice(0, 1024),
        inline: f.inline ?? false,
      })),
    }),
    ...(opts.url && { url: opts.url }),
  }

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'KAIROS',
        avatar_url: 'https://i.imgur.com/VdhpqV1.png', // Lightning bolt placeholder
        embeds: [embed],
      }),
      signal: AbortSignal.timeout(5000),
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      logError(`Discord webhook failed: HTTP ${response.status} ${errBody.slice(0, 200)}`)
      return false
    }

    return true
  } catch (err) {
    logError('Discord post failed', err)
    return false
  }
}

/**
 * Convenience: post a plain text message (no embed). Useful for quick pings.
 */
export async function postPlainToDiscord(
  sandboxDir: string,
  text: string,
): Promise<boolean> {
  const webhook = getWebhookUrl(sandboxDir)
  if (!webhook) return false

  try {
    const response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'KAIROS',
        content: text.slice(0, 2000), // Discord plain text limit
      }),
      signal: AbortSignal.timeout(5000),
    })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Check if Discord is configured (for use in conditional logic).
 */
export function isDiscordConfigured(sandboxDir: string): boolean {
  return getWebhookUrl(sandboxDir) !== null
}

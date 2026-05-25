// src/daemon/restraint/urgencyFloor.ts
// Explicit list of conditions that ALWAYS produce an urgent interrupt
// regardless of any score, suspension, cooldown, or focus state.
//
// This is the safety valve against the over-correction failure mode of
// the restraint architecture. Without UrgencyFloor, an over-tuned
// restraint stack can silence genuinely important things.
//
// Categories (each is an opt-in classifier):
//   - System-critical intents (low_disk, security, error)
//   - Explicit `always_interrupt` flag on the request
//   - Calendar events starting in < 5 min
//   - Password / API key / private key in clipboard
//   - Direct @mention of the user in any message body
//   - URGENT / ASAP keyword in reasoning
//   - Active-task errors
//
// Adding to this list should require explicit deliberation. Each addition
// is a NEW way the restraint stack can be bypassed.

import type { ActionRequest } from '../agency/types'

export type UrgencyFloorOptions = {
  user_handles?: string[]      // for @mention detection (e.g., ['nirmal', 'nghinai'])
  imminent_meeting_window_ms?: number  // default 5 min
}

const SYSTEM_CRITICAL_INTENTS = new Set([
  'system_critical',
  'security_alert',
  'task_error',
])

const URGENT_KEYWORDS = /\b(urgent|asap|now|critical|emergency|immediately)\b/i

// Common secret patterns — extend conservatively
const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/,                          // OpenAI / Anthropic API key
  /ghp_[a-zA-Z0-9]{20,}/,                           // GitHub personal access token
  /github_pat_[a-zA-Z0-9_]{20,}/,                   // GitHub fine-grained PAT
  /xox[bpoa]-[a-zA-Z0-9-]+/,                        // Slack token
  /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/,  // SSH/PGP private keys
  /AIza[0-9A-Za-z_-]{35}/,                          // Google API key
  /AKIA[A-Z0-9]{16}/,                               // AWS access key id
]

export class UrgencyFloor {
  private userHandles: string[]
  private imminentWindowMs: number

  constructor(opts?: UrgencyFloorOptions) {
    this.userHandles = opts?.user_handles ?? []
    this.imminentWindowMs = opts?.imminent_meeting_window_ms ?? 5 * 60_000
  }

  classify(request: ActionRequest): boolean {
    // 1. Explicit always_interrupt flag on request OR trigger config
    if ((request as any).always_interrupt === true) return true

    // 2. System-critical intent class
    if (SYSTEM_CRITICAL_INTENTS.has(request.intent_id)) return true

    // 3. Calendar event imminent
    const kind = (request.args as any)?.kind
    if (kind === 'calendar') {
      const startsAt = (request.args as any)?.starts_at
      if (typeof startsAt === 'number' && startsAt - Date.now() < this.imminentWindowMs && startsAt > Date.now()) {
        return true
      }
    }

    // 4. Active-task error
    if (kind === 'task_error') return true

    // 5. Password / API key / private key in clipboard
    if (kind === 'clipboard') {
      const body = (request.args as any)?.body ?? (request.args as any)?.text ?? ''
      if (typeof body === 'string') {
        for (const re of SECRET_PATTERNS) {
          if (re.test(body)) return true
        }
      }
    }

    // 6. Direct @mention of user in any body
    if (this.userHandles.length > 0) {
      const body = (request.args as any)?.body ?? ''
      if (typeof body === 'string') {
        for (const h of this.userHandles) {
          // Word-boundary match on @handle to avoid partial-name false positives
          const re = new RegExp(`@${h}\\b`, 'i')
          if (re.test(body)) return true
        }
      }
    }

    // 7. URGENT/ASAP keyword in reasoning
    if (URGENT_KEYWORDS.test(request.reasoning)) return true

    return false
  }
}

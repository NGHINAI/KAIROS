import { appendFileSync, readFileSync, statSync } from 'fs'
import type { UserChannel } from './types'

interface InboxUserChannelConfig {
  path: string
  pollIntervalMs?: number
}

/**
 * File-based UserChannel that appends lines to a markdown file and polls for user replies.
 * C.2.5 implementation — Phase F replaces with SwiftUI glass chat surface.
 */
export class InboxUserChannel implements UserChannel {
  private path: string
  private pollIntervalMs: number

  constructor(config: InboxUserChannelConfig) {
    this.path = config.path
    this.pollIntervalMs = config.pollIntervalMs ?? 250
  }

  async speak(text: string): Promise<void> {
    const line = `[${this.timestamp()}] KAIROS: ${text}\n`
    appendFileSync(this.path, line, 'utf8')
  }

  async notifyProgress(step: number, total: number, label: string): Promise<void> {
    const line = `[${this.timestamp()}] KAIROS [${step}/${total}]: ${label}\n`
    appendFileSync(this.path, line, 'utf8')
  }

  async notifyComplete(serviceName: string, summary: string): Promise<void> {
    const line = `[${this.timestamp()}] KAIROS ✓: ${serviceName} — ${summary}\n`
    appendFileSync(this.path, line, 'utf8')
  }

  async notifyFailed(serviceName: string, error: string, remedy?: string): Promise<void> {
    const line = `[${this.timestamp()}] KAIROS ✗: ${serviceName} — ${error}\n`
    appendFileSync(this.path, line, 'utf8')
    if (remedy) {
      const remedyLine = `[${this.timestamp()}] KAIROS remedy: ${remedy}\n`
      appendFileSync(this.path, remedyLine, 'utf8')
    }
  }

  async awaitConfirm(prompt: string, defaultChoice?: 'yes' | 'no'): Promise<boolean> {
    // Build the confirmation prompt line
    let promptLine = `[${this.timestamp()}] KAIROS [confirm]: ${prompt} (y/n)`
    if (defaultChoice) {
      promptLine += ` [default=${defaultChoice}]`
    }
    promptLine += '\n'

    // Append the prompt to the file
    appendFileSync(this.path, promptLine, 'utf8')

    // Record file size at moment of asking — only new content after this offset counts
    let sizeAtPrompt = statSync(this.path).size

    // Poll the file for a user reply
    return new Promise((resolve) => {
      const pollInterval = setInterval(() => {
        try {
          const content = readFileSync(this.path, 'utf8')
          const currentSize = statSync(this.path).size

          // Only look at content added after the prompt
          const newContent = content.slice(sizeAtPrompt)

          // Match lines like "USER: yes" or "USER: no" (case-insensitive)
          const userReplyMatch = newContent.match(/^USER:\s*(yes|y|no|n)\s*$/im)
          if (userReplyMatch) {
            clearInterval(pollInterval)
            const reply = userReplyMatch[1].toLowerCase()
            resolve(reply === 'yes' || reply === 'y')
          }
        } catch (err) {
          // Ignore read errors during polling
        }
      }, this.pollIntervalMs)
    })
  }

  private timestamp(): string {
    return new Date().toISOString().slice(11, 19)
  }
}

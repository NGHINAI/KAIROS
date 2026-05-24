// Voice system: loads template pools and picks message variations.
// Keeps KAIROS's personality consistent without generating every message from scratch.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { log } from './logger'

type TemplatePool = string[]
type VoiceConfig = {
  taboo_phrases: string[]
  preferred_openers: string[]
  max_emoji_per_message: number
  max_sentences_per_message: number
  tone_anchors: string[]
}

export class Voice {
  private pools: Map<string, TemplatePool> = new Map()
  private config: VoiceConfig | null = null

  constructor(private sandboxDir: string) {
    this.loadTemplates()
    this.loadConfig()
  }

  private loadConfig(): void {
    const path = join(this.sandboxDir, 'src', 'prompts', 'voice.json')
    if (existsSync(path)) {
      try {
        this.config = JSON.parse(readFileSync(path, 'utf8'))
      } catch {
        log('Failed to load voice.json', 'warn')
      }
    }
  }

  private loadTemplates(): void {
    const dir = join(this.sandboxDir, 'src', 'templates')
    if (!existsSync(dir)) return

    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const content = readFileSync(join(dir, file), 'utf8')
        const templates = JSON.parse(content) as string[]
        const name = file.replace('.json', '')
        this.pools.set(name, templates)
      } catch {
        log(`Failed to load template: ${file}`, 'warn')
      }
    }

    log(`Loaded ${this.pools.size} template pool(s)`)
  }

  /**
   * Pick a random template from the named pool and fill in variables.
   * Variables in templates look like {var_name}.
   * Falls back to a plain message if no templates exist.
   */
  pickAndRender(pool: string, vars: Record<string, string>): string {
    const templates = this.pools.get(pool)
    if (!templates || templates.length === 0) {
      // No templates — just use the first var value or a generic message
      return vars['summary'] ?? vars['message'] ?? 'Done.'
    }

    // Pick random
    const template = templates[Math.floor(Math.random() * templates.length)]!
    let rendered = template

    // Replace {var_name} with values
    for (const [key, value] of Object.entries(vars)) {
      rendered = rendered.replaceAll(`{${key}}`, value)
    }

    // Clean up any unreplaced vars
    rendered = rendered.replace(/\{[a-z_]+\}/g, '')

    return rendered.trim()
  }

  /**
   * Check if a message contains taboo phrases and remove them.
   */
  sanitize(message: string): string {
    if (!this.config) return message
    let result = message
    for (const phrase of this.config.taboo_phrases) {
      const re = new RegExp(phrase, 'gi')
      result = result.replace(re, '')
    }
    // Clean up double spaces from removals
    return result.replace(/\s{2,}/g, ' ').trim()
  }

  getConfig(): VoiceConfig | null {
    return this.config
  }
}

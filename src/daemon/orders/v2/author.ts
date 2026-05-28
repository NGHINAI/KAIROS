// src/daemon/orders/v2/author.ts
// Speech-to-rule: takes natural language, calls the LLM (orders_compose tier),
// derives a unique slug, writes a YAML frontmatter block to STANDING_ORDERS.md,
// and updates OrdersStore. Rules default to 24h dry-run.

import { appendFileSync, writeFileSync, existsSync } from 'fs'
import { stringify as stringifyYaml } from 'yaml'
import type { ModelRouter } from '../../llm/router'
import type { OrdersStore } from './store'
import type { OrdersParser } from './parser'
import type { Rule, Action, When } from './types'

const SYSTEM_PROMPT = `You are KAIROS's standing-orders compiler. The user just spoke a request like "remind me every Monday at 9 to send the standup". Convert it into a structured rule object.

Return STRICT JSON only:
{
  "proposed_rule": {
    "when": { "cron": "0 9 * * 1" } | { "at": "5pm" } | { "event": "name" } | { "state": { ... } },
    "if": ["persona.X == 'Y'", ...],
    "unless": ["persona.is_in_meeting", ...],
    "do": [{ "action": "notify"|"invoke_skill"|"composio_tool"|"emit_event"|..., "args": { ... } }],
    "cooldown": "20h" | "5m" | ...
  },
  "slug_suggestion": "kebab-case-slug",
  "similar_existing": null | "<slug-of-existing-rule-this-duplicates>",
  "confidence": 0.0-1.0
}

Guidance:
- For time-based rules ("every Monday at 9", "at 5pm") use cron/at
- For state-triggered ("if a Slack DM has 'urgent'") use when.state
- Action types: notify, remind_later, add_to_memory, log, suspend, invoke_skill, composio_tool, emit_event
- If the request resembles one of the EXISTING rules below, set similar_existing to that slug; otherwise null
- Confidence reflects how sure you are about the structure`

export type OrdersAuthorDeps = {
  router: ModelRouter
  store: OrdersStore
  parser: OrdersParser
  filePath: string
}

export type AuthorResult = {
  created_slug: string | null
  similar_existing?: string
  error?: string
}

export class OrdersAuthor {
  constructor(private deps: OrdersAuthorDeps) {}

  async handleSpeech(text: string): Promise<AuthorResult> {
    const existing = this.deps.store.listAll().map(r => ({
      slug: r.slug,
      when_kind: this.whenKindOf(r.when),
      description: r.description?.slice(0, 80) ?? '',
    }))
    const userPrompt = `User said: "${text}"

Existing rules (for dedup check):
${existing.length === 0 ? '(none)' : existing.map(e => `- ${e.slug} (${e.when_kind}): ${e.description}`).join('\n')}

Produce the JSON object.`

    let parsed: any
    try {
      const result = await this.deps.router.complete({
        task_type: 'orders_compose' as any,
        system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
        prompt: userPrompt,
        structured: true,
        max_output_tokens: 1500,
        latency_target: 'standard',
      })
      parsed = result.parsed
    } catch (err) {
      return { created_slug: null, error: err instanceof Error ? err.message : String(err) }
    }
    if (!parsed?.proposed_rule || !parsed.slug_suggestion) {
      return { created_slug: null, error: 'LLM output missing proposed_rule or slug_suggestion' }
    }
    if (parsed.similar_existing) {
      return { created_slug: null, similar_existing: parsed.similar_existing }
    }
    const slug = this.uniqueSlug(parsed.slug_suggestion)
    const now = Date.now()
    const rule: Rule = {
      schema_version: 1,
      slug,
      when: parsed.proposed_rule.when as When,
      if: parsed.proposed_rule.if,
      unless: parsed.proposed_rule.unless,
      do: parsed.proposed_rule.do as Action[],
      cooldown_ms: parsed.proposed_rule.cooldown ? this.deps.parser.parseDuration(parsed.proposed_rule.cooldown) : undefined,
      dry_run_until: now + 24 * 60 * 60 * 1000,
      state: 'dry_run',
      created_by: 'voice',
      created_at: now,
      description: `You said: "${text}"`,
    }
    this.appendRuleBlock(rule, parsed.proposed_rule.cooldown)
    this.deps.store.upsert(rule)
    return { created_slug: slug }
  }

  private uniqueSlug(suggested: string): string {
    if (!this.deps.store.get(suggested)) return suggested
    let i = 2
    while (this.deps.store.get(`${suggested}-${i}`)) i++
    return `${suggested}-${i}`
  }

  private whenKindOf(when: When): string {
    if ('cron' in when) return 'cron'
    if ('at' in when) return 'at'
    if ('event' in when) return 'event'
    return 'state'
  }

  private appendRuleBlock(rule: Rule, cooldownStr: string | undefined): void {
    if (!existsSync(this.deps.filePath)) {
      writeFileSync(this.deps.filePath, '# KAIROS Standing Orders\n')
    }
    const frontmatter: Record<string, unknown> = {
      schema_version: 1,
      when: rule.when,
      ...(rule.if ? { if: rule.if } : {}),
      ...(rule.unless ? { unless: rule.unless } : {}),
      do: rule.do,
      ...(cooldownStr ? { cooldown: cooldownStr } : {}),
      ...(rule.dry_run_until ? { dry_run_until: new Date(rule.dry_run_until).toISOString() } : {}),
      state: rule.state,
      created_by: rule.created_by,
      created_at: new Date(rule.created_at).toISOString(),
    }
    const block = `\n## ${rule.slug}\n---\n${stringifyYaml(frontmatter).trimEnd()}\n---\n${rule.description ?? ''}\n`
    appendFileSync(this.deps.filePath, block)
  }
}

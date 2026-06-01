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
import type { PendingEditsQueue } from './pendingEdits'
import type { TriggerSchemaCache } from '../../connectors/triggers/schemaCache'
import type { TriggerInstanceManager } from '../../connectors/triggers/instanceManager'
import type { ConnectGuard } from '../../connectors/triggers/connectGuard'
import type { ComposioToolResolver } from './composioToolResolver'

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
  pendingQueue?: PendingEditsQueue   // NEW — optional; if omitted, behavior matches C.4.1
  // NEW (Phase D — all optional)
  schemaCache?: TriggerSchemaCache
  instanceManager?: TriggerInstanceManager
  connectGuard?: ConnectGuard
  // NEW (Phase D fixup — for grounding composio_tool action authoring in real schemas)
  toolResolver?: ComposioToolResolver
  /** Returns the toolkit slugs the user currently has connected (e.g. ['gmail','googlecalendar']).
   *  Used to filter the action-tool catalog into the LLM prompt — otherwise we'd dump 1000s. */
  getConnectedToolkits?: () => string[]
  /** Max action tools per toolkit to include in the prompt — prevents prompt bloat. */
  toolsPerToolkitCap?: number
}

export type AuthorResult = {
  created_slug: string | null
  similar_existing?: string
  error?: string
  queued_for_retry?: boolean          // NEW
}

export class OrdersAuthor {
  constructor(private deps: OrdersAuthorDeps) {}

  private buildSystemPrompt(): string {
    let prompt = SYSTEM_PROMPT
    // ── Triggers (incoming events the LLM can match `when.state.incoming_event` against) ──
    if (this.deps.schemaCache) {
      const cache: any = this.deps.schemaCache as any
      const map: Map<string, any> | undefined = cache.map
      if (map && map.size > 0) {
        prompt += `\n\nAvailable Composio triggers (toolkit:slug — description):\n`
        for (const [slug, t] of map) {
          prompt += `- ${t.toolkit}:${slug} — ${t.description}\n`
        }
        prompt += `\nFor rules like 'notify me when X', use:\n  when:\n    state:\n      incoming_event:\n        trigger: <TRIGGER_SLUG>\n  if:\n    - "payload.<field> == '<value>'"  # client-side filter\n`
      }
    }
    // ── Action tools (outbound calls — `do: composio_tool`). Grounded in real Composio schemas ──
    // Two sections: CONNECTED (full tool details) and AVAILABLE (toolkit name only).
    // For AVAILABLE toolkits, the LLM can still propose a rule; KAIROS detects the
    // unconnected toolkit post-LLM and triggers OAuth via ConnectGuard, putting the
    // rule into state=pending_connection until the user authorizes.
    if (this.deps.toolResolver) {
      const connected = (this.deps.getConnectedToolkits?.() ?? []).map(t => t.toLowerCase())
      const connectedSet = new Set(connected)
      const allToolkits = this.deps.toolResolver.listAllToolkits()
      const cap = this.deps.toolsPerToolkitCap ?? 25

      if (connected.length > 0) {
        prompt += `\n\nCONNECTED Composio toolkits (full tool catalog — prefer these):\n`
        for (const toolkit of connected) {
          const tools = this.deps.toolResolver.listToolsForToolkit(toolkit).slice(0, cap)
          if (tools.length === 0) continue
          prompt += `\n  ${toolkit}:\n`
          for (const t of tools) {
            const required = this.summarizeRequiredArgs(t.inputParameters)
            const desc = t.description ? ` — ${t.description.slice(0, 100)}` : ''
            prompt += `    - ${t.friendly}: required=[${required}]${desc}\n`
          }
        }
      }

      const available = allToolkits.filter(t => !connectedSet.has(t))
      if (available.length > 0) {
        prompt += `\n\nAVAILABLE-but-unconnected Composio toolkits (user has NOT authed these yet — KAIROS will request OAuth before the rule activates):\n  ${available.join(', ')}\n`
        prompt += `\nIf the user's request needs an unconnected toolkit, STILL propose the rule normally with the right toolkit slug. Use the tool name you'd expect Composio to expose (e.g. 'send_message' for slack, 'create_issue' for linear). KAIROS will (1) prompt OAuth for that toolkit, (2) resolve the canonical tool slug, (3) activate the rule. Do NOT refuse the request just because the toolkit isn't connected.\n`
      }

      if (connected.length > 0 || available.length > 0) {
        prompt += `\nWhen generating a composio_tool action, use the friendly tool name (not the canonical slug):\n  - action: composio_tool\n    args:\n      toolkit: <toolkit_slug>\n      tool: <friendly_name>     # e.g. 'send_email' NOT 'GMAIL_SEND_EMAIL'\n      args:\n        <field>: <value>\n`
        prompt += `\nIMPORTANT for CONNECTED toolkits: pick tools and arg names ONLY from the catalog above; do NOT invent.\n`
      }
    }
    return prompt
  }

  /** Extracts a brief "required arg names" summary from a Composio inputParameters JSON-schema fragment. */
  private summarizeRequiredArgs(schema: any): string {
    if (!schema || typeof schema !== 'object') return ''
    const required: string[] = Array.isArray(schema.required) ? schema.required : []
    if (required.length === 0) {
      // Some schemas mark fields required via a per-property `required: true`; sweep for that too.
      const props = (schema.properties ?? {}) as Record<string, any>
      const swept: string[] = []
      for (const [k, v] of Object.entries(props)) {
        if (v && typeof v === 'object' && (v as any).required === true) swept.push(k)
      }
      return swept.slice(0, 8).join(', ')
    }
    return required.slice(0, 8).join(', ')
  }

  async handleSpeech(text: string): Promise<AuthorResult> {
    try {
      return await this.handleSpeechDirect(text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (this.deps.pendingQueue) {
        this.deps.pendingQueue.enqueue(text)
        this.deps.pendingQueue.enforceCapacityCap()
        return { created_slug: null, queued_for_retry: true, error: msg }
      }
      return { created_slug: null, error: msg }
    }
  }

  async handleSpeechDirect(text: string): Promise<AuthorResult> {
    const existing = this.deps.store.listAll().map(r => ({
      slug: r.slug,
      when_kind: this.whenKindOf(r.when),
      description: r.description?.slice(0, 80) ?? '',
    }))
    const userPrompt = `User said: "${text}"

Existing rules (for dedup check):
${existing.length === 0 ? '(none)' : existing.map(e => `- ${e.slug} (${e.when_kind}): ${e.description}`).join('\n')}

Produce the JSON object.`

    // NOTE: no try/catch around router.complete() — let throws propagate
    const result = await this.deps.router.complete({
      task_type: 'orders_compose' as any,
      system_blocks: [{ text: this.buildSystemPrompt(), cache_hint: 'long' }],
      prompt: userPrompt,
      structured: true,
      max_output_tokens: 1500,
      latency_target: 'standard',
    })

    const parsed = result.parsed as any
    if (!parsed?.proposed_rule || !parsed.slug_suggestion) {
      throw new Error('LLM output missing proposed_rule or slug_suggestion')
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
    // Phase D — gate incoming_event rules through ConnectGuard + InstanceManager
    if ('state' in rule.when && (rule.when.state as any).incoming_event) {
      const ie = (rule.when.state as any).incoming_event
      const schema = this.deps.schemaCache ? await this.deps.schemaCache.resolveOrRefresh(ie.trigger) : null
      const toolkit = schema?.toolkit ?? 'unknown'

      if (this.deps.connectGuard) {
        const status = await this.deps.connectGuard.ensureConnected(toolkit, rule.slug)
        if (status === 'pending') {
          rule.state = 'pending_connection'
        }
      }

      if (rule.state !== 'pending_connection' && this.deps.instanceManager) {
        try {
          // For v1, use a placeholder ca_id; daemon wire-up will refine via ConnectionStore lookup
          await this.deps.instanceManager.acquireForRule(rule.slug, ie.trigger, ie.config ?? {}, 'local_default')
        } catch (err) {
          rule.state = 'suspended'
          rule.description = (rule.description ?? '') + `\n\n(Failed to register trigger: ${err instanceof Error ? err.message : String(err)})`
        }
      }
    }

    // Phase D fixup — gate composio_tool ACTIONS through ConnectGuard for any
    // toolkit the user hasn't authed yet. Same pattern as the trigger gate above.
    // Without this, rules referencing unconnected toolkits would silently fail at
    // execute time with "could not resolve composio tool".
    if (this.deps.connectGuard) {
      const actionToolkits = this.collectComposioActionToolkits(rule.do)
      if (actionToolkits.length > 0) {
        const connected = new Set((this.deps.getConnectedToolkits?.() ?? []).map(t => t.toLowerCase()))
        for (const toolkit of actionToolkits) {
          if (connected.has(toolkit)) continue
          const status = await this.deps.connectGuard.ensureConnected(toolkit, rule.slug)
          if (status === 'pending') {
            rule.state = 'pending_connection'
            // Don't break — call ensureConnected for all toolkits so OAuth flows
            // can start in parallel. ConnectGuard handles dedupe.
          }
        }
      }
    }

    this.appendRuleBlock(rule, parsed.proposed_rule.cooldown)
    this.deps.store.upsert(rule)
    return { created_slug: slug }
  }

  /** Walk a Rule's `do` array and return the unique lowercase toolkit slugs
   *  referenced by composio_tool actions. */
  private collectComposioActionToolkits(actions: Action[]): string[] {
    const set = new Set<string>()
    for (const a of actions ?? []) {
      if ((a as any).action === 'composio_tool') {
        const tk = String((a as any).args?.toolkit ?? '').toLowerCase()
        if (tk) set.add(tk)
      }
    }
    return [...set]
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

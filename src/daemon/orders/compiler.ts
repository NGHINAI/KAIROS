// Compiles free-form English standing orders into structured triggers
// stored in the database. Recompiles only when source content hash
// changes. Each rule maps to one or more triggers.

import type { Database } from 'bun:sqlite'
import { logError, log } from '../logger'
import type { ModelRouter } from '../llm/router'

export const ORDERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS compiled_orders_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS compiled_orders_triggers (
    id          TEXT PRIMARY KEY,
    when_kind   TEXT NOT NULL,
    when_match  TEXT NOT NULL,
    condition   TEXT,
    action      TEXT NOT NULL,
    source_rule TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
`

const SYSTEM_PROMPT = `You are KAIROS's standing-orders compiler. Convert plain-English rules into structured trigger specifications.

For each rule, emit 1+ triggers. Each trigger has:
- id: short stable kebab-case id derived from rule
- when_kind: one of "calendar" | "clipboard" | "focus-app" | "file-events" | "browser-tabs" | "time" | "pattern"
- when_match: semi-structured selector. Examples:
    "event.startsIn(10min)"  "text.isURL()"  "app.equals('Slack')"  "path.endsWith('.ts')"
    "tabs.opened()"  "time.between(11:00, 22:00)"  "pattern.repeats(3, 10min, sameFile)"
- condition: optional. Examples: "NOT focus_app.is_video", "focus_app == 'Slack'"
- action: one of "notify" | "remind_later" | "add_to_memory" | "draft_reply" | "suspend" | "log"

If a rule restricts timing (e.g. "never on Sunday morning"), encode as a separate trigger with action "suspend" and appropriate when_kind: "time".

For EACH emitted trigger, include "source_rule_number": the 1-based index of the input rule that this trigger came from. This is used for attribution + debugging.

Output strict JSON:
{
  "triggers": [
    { "id": "...", "when_kind": "...", "when_match": "...", "condition": null|"...", "action": "...", "source_rule_number": 1 }
  ]
}`

export type CompiledTrigger = {
  id: string
  when_kind: string
  when_match: string
  condition: string | null
  action: string
  source_rule: string
}

export class OrdersCompiler {
  constructor(private db: Database, private router: ModelRouter) {
    db.exec(ORDERS_SCHEMA)
  }

  async compile(rules: string[], sourceHash: string): Promise<{ triggers: CompiledTrigger[]; skipped: boolean }> {
    const last = this.db.query('SELECT value FROM compiled_orders_meta WHERE key = ?').get('source_hash') as { value: string } | null
    if (last?.value === sourceHash) {
      return { triggers: this.list(), skipped: true }
    }

    if (rules.length === 0) {
      this.replaceAll([])
      this.setMeta('source_hash', sourceHash)
      return { triggers: [], skipped: false }
    }

    try {
      const prompt = `Rules:\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nProduce the JSON.`
      const result = await this.router.complete({
        task_type: 'action_compose',
        system_blocks: [{ text: SYSTEM_PROMPT, cache_hint: 'long' }],
        prompt,
        structured: true,
        max_output_tokens: 1200,
        latency_target: 'background',
      })
      const parsed = result.parsed as { triggers?: Array<Omit<CompiledTrigger, 'source_rule'> & { source_rule_number?: number }> } | undefined
      const compiled: CompiledTrigger[] = (parsed?.triggers ?? []).map((t, i) => {
        // Prefer LLM-provided source_rule_number (1-based); fall back to
        // position index only if the model omitted it. This fixes the
        // attribution bug where source_rule showed the wrong rule when
        // the LLM emitted triggers in different order than input rules.
        const ruleNumber = t.source_rule_number ?? (i + 1)
        const idx = Math.max(0, Math.min(rules.length - 1, ruleNumber - 1))
        const { source_rule_number, ...triggerFields } = t
        return {
          ...triggerFields,
          source_rule: rules[idx] ?? rules[0] ?? '',
        }
      })
      this.replaceAll(compiled)
      this.setMeta('source_hash', sourceHash)
      log(`OrdersCompiler: ${rules.length} rules → ${compiled.length} triggers`)
      return { triggers: compiled, skipped: false }
    } catch (err) {
      logError('OrdersCompiler: compilation failed', err)
      return { triggers: this.list(), skipped: false }
    }
  }

  list(): CompiledTrigger[] {
    return this.db.query('SELECT * FROM compiled_orders_triggers').all() as CompiledTrigger[]
  }

  private replaceAll(triggers: CompiledTrigger[]): void {
    this.db.exec('DELETE FROM compiled_orders_triggers')
    const now = Date.now()
    for (const t of triggers) {
      this.db.run(
        `INSERT INTO compiled_orders_triggers (id, when_kind, when_match, condition, action, source_rule, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [t.id, t.when_kind, t.when_match, t.condition, t.action, t.source_rule, now],
      )
    }
  }

  private setMeta(key: string, value: string): void {
    this.db.run('INSERT OR REPLACE INTO compiled_orders_meta (key, value) VALUES (?, ?)', [key, value])
  }
}

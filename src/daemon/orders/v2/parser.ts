// src/daemon/orders/v2/parser.ts
// Parses STANDING_ORDERS.md into typed Rule objects.
// Format: `## <slug>` headers + YAML frontmatter blocks. Bad rules are
// logged & skipped; other rules continue (matches v1's lenient behavior).

import { readFileSync } from 'fs'
import { parse as parseYaml } from 'yaml'
import type { Rule, Action, When, LifecycleState, CreatedBy } from './types'

const SLUG_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/
const DURATION_REGEX = /^(\d+)(s|m|h|d)$/

const ALLOWED_ACTIONS = new Set([
  'notify', 'remind_later', 'add_to_memory', 'log', 'suspend',
  'invoke_skill', 'composio_tool', 'emit_event',
])
const ALLOWED_LIFECYCLE = new Set<LifecycleState>(['pending', 'active', 'suspended', 'dry_run', 'legacy'])
const ALLOWED_CREATED_BY = new Set<CreatedBy>(['voice', 'manual', 'crystallized', 'migrated_v1'])

export type ParseError = { slug: string; error: string }
export type ParseResult = { rules: Rule[]; errors: ParseError[] }

export class OrdersParser {
  parseString(text: string): ParseResult {
    const rules: Rule[] = []
    const errors: ParseError[] = []
    const lines = text.split('\n')
    let i = 0
    while (i < lines.length) {
      const m = lines[i]!.match(/^## ([a-z0-9][a-z0-9-]*)\s*$/i)
      if (!m) { i++; continue }
      const slug = m[1]!
      i++
      if (lines[i]?.trim() !== '---') { continue }
      i++
      const yamlStart = i
      while (i < lines.length && lines[i]?.trim() !== '---') i++
      const yamlEnd = i
      i++ // skip closing ---
      const descStart = i
      while (i < lines.length && !/^## [a-z0-9][a-z0-9-]*/i.test(lines[i]!)) i++
      const descEnd = i
      const yamlText = lines.slice(yamlStart, yamlEnd).join('\n')
      const description = lines.slice(descStart, descEnd).join('\n').trim() || undefined
      try {
        const raw = parseYaml(yamlText) as Record<string, unknown>
        const rule = this.validate(slug, raw, description)
        rules.push(rule)
      } catch (err) {
        errors.push({ slug, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { rules, errors }
  }

  parseFile(path: string): ParseResult {
    return this.parseString(readFileSync(path, 'utf8'))
  }

  parseDuration(s: string): number {
    const m = s.match(DURATION_REGEX)
    if (!m) throw new Error(`invalid Duration: ${s}`)
    const n = parseInt(m[1]!, 10)
    const unit = m[2]!
    const mult = unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000
    return n * mult
  }

  private validate(headerSlug: string, raw: Record<string, unknown>, description: string | undefined): Rule {
    if (!SLUG_REGEX.test(headerSlug)) throw new Error(`invalid slug "${headerSlug}" — must be kebab-case`)
    if (raw.schema_version !== 1) throw new Error(`unsupported schema_version: ${raw.schema_version}`)
    if (!raw.when || typeof raw.when !== 'object') throw new Error('missing when')
    const w = raw.when as Record<string, unknown>
    const whenKeys = Object.keys(w).filter(k => ['cron', 'at', 'event', 'state'].includes(k))
    if (whenKeys.length !== 1) throw new Error(`when must have exactly one of {cron, at, event, state}, got [${whenKeys.join(',')}]`)
    const doArr = raw.do as Action[] | undefined
    if (!Array.isArray(doArr) || doArr.length === 0) throw new Error('do must be non-empty array')
    for (const a of doArr) {
      if (!a || typeof a !== 'object' || !ALLOWED_ACTIONS.has((a as any).action)) {
        throw new Error(`invalid action: ${JSON.stringify(a)}`)
      }
    }
    const state = raw.state as LifecycleState
    if (!ALLOWED_LIFECYCLE.has(state)) throw new Error(`invalid state: ${state}`)
    const createdBy = raw.created_by as CreatedBy
    if (!ALLOWED_CREATED_BY.has(createdBy)) throw new Error(`invalid created_by: ${createdBy}`)
    if (!raw.created_at) throw new Error('missing created_at')
    const cooldownStr = raw.cooldown as string | undefined
    const cooldown_ms = cooldownStr ? this.parseDuration(cooldownStr) : undefined
    return {
      schema_version: 1,
      slug: headerSlug,
      when: raw.when as When,
      if: raw.if as string[] | undefined,
      unless: raw.unless as string[] | undefined,
      do: doArr,
      cooldown_ms,
      dry_run_until: raw.dry_run_until ? new Date(raw.dry_run_until as string).getTime() : undefined,
      state,
      created_by: createdBy,
      created_at: new Date(raw.created_at as string).getTime(),
      description,
    }
  }
}

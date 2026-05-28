// src/daemon/orders/v2/approvalPrompt.ts
// Builds an inbox prompt for a rule whose dry-run window has expired.

import type { Rule } from './types'
import type { DryRunLogger } from './dryRunLogger'

export type ApprovalPrompt = {
  slug: string
  title: string
  body: string
  actions: Array<'approve' | 'reject' | 'tune'>
}

export function buildApprovalPrompt(rule: Rule, logger: DryRunLogger, now: number): ApprovalPrompt {
  const summary = logger.summarize(rule, now)
  const sampleLines = summary.samples.length === 0 ? '(no fires)' :
    summary.samples.map(s => `  - ${new Date(s.fired_at).toISOString()}`).join('\n')
  return {
    slug: rule.slug,
    title: `Rule '${rule.slug}' finished 24h dry-run`,
    body: `Would have fired ${summary.fire_count} times. Recent fires:\n${sampleLines}\n\nApprove to go live, reject to suspend, or tune to adjust cooldown.`,
    actions: ['approve', 'reject', 'tune'],
  }
}

/** Apply approval: clear dry_run_until and set state=active. */
export function applyApproval(rule: Rule): Rule {
  return { ...rule, dry_run_until: undefined, state: 'active' }
}

export function applyRejection(rule: Rule): Rule {
  return { ...rule, state: 'suspended' }
}

// src/daemon/skills/invokeSkillIntent.ts
// Agency intent that lets the agent invoke a skill by slug.
// Tier: GREEN at the intent level — actual safety comes from the per-skill autonomy tier
// classified by PersonaGate during crystallization (GREEN/YELLOW/ORANGE/RED).
// ORANGE/RED skills are gated upstream via ReviewQueue, so by the time a skill is in
// SkillRegistry.listActive(), it has been approved.

import type { Intent } from '../agency/types'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { ActionContext } from '../agency/actionExecutor'
import type { SkillDispatcher } from './skillDispatcher'

export type InvokeSkillIntentDeps = {
  dispatcher: Pick<SkillDispatcher, 'invoke'>
}

export const invokeSkillIntentDescriptor: Intent = {
  id: 'invoke_skill',
  description: "Invoke a crystallized skill by slug. The skill list is provided in the system prompt with name + description for each available skill. Pass any required args as a JSON object.",
  tier: 'GREEN',
  argSchema: { slug: 'string', args: 'object' },
}

export function registerInvokeSkillIntent(
  registry: IntentRegistry,
  deps: InvokeSkillIntentDeps,
): void {
  registry.register(invokeSkillIntentDescriptor, async (
    args: Record<string, unknown>,
    _ctx: ActionContext,
  ) => {
    if (typeof args.slug !== 'string' || args.slug.trim() === '') {
      return { status: 'failure' as const, details: 'invoke_skill: slug is required (string)' }
    }
    const skillArgs = (args.args ?? {}) as Record<string, unknown>
    if (typeof skillArgs !== 'object' || skillArgs === null) {
      return { status: 'failure' as const, details: 'invoke_skill: args must be an object' }
    }
    try {
      const result = await deps.dispatcher.invoke(args.slug, skillArgs)
      return {
        status: result.ok ? 'success' as const : 'failure' as const,
        details: result.ok
          ? `Invoked '${args.slug}' via ${result.sandbox} (${result.duration_ms}ms). Output: ${(result.output ?? '').slice(0, 500)}`
          : `Skill '${args.slug}' failed in ${result.sandbox}: ${result.error ?? 'unknown error'}`,
      }
    } catch (err) {
      return {
        status: 'failure' as const,
        details: `invoke_skill: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  })
}

// src/daemon/orders/v2/actionDispatcher.ts
// Executes a rule's Action[] sequentially. Routes by action.type.
// Variable interpolation runs on each action's args before dispatch.
// ${skill_output} captures the previous action's output for chaining.

import { interpolateObject } from './interp'
import type { Action, ActionResult, TriggerContext } from './types'
import type { RulesEventBus } from './eventBus'

const INTENT_ACTIONS = new Set(['notify', 'remind_later', 'add_to_memory', 'log', 'suspend'])

export type ActionDispatcherDeps = {
  intentRegistry: {
    get(id: string): { handler: (args: any, ctx?: any) => Promise<{ status: string; details?: string }> } | null
  }
  skillDispatcher: {
    invoke(slug: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: unknown; error?: string; duration_ms: number; sandbox: string }>
  }
  /** Composio integration. Both fields together OR null to disable. */
  composio: {
    resolver: { resolveOrRefresh(toolkit: string, tool: string): Promise<string | null> }
    executeTool(args: { toolName: string; userId: string; arguments: any }): Promise<any>
    userId: string
  } | null
  eventBus: RulesEventBus
}

export class ActionDispatcher {
  constructor(private deps: ActionDispatcherDeps) {}

  async dispatch(actions: Action[], ctx: TriggerContext): Promise<ActionResult> {
    // skill_output_raw tracks the last skill/composio output for ${skill_output} chaining.
    // Bare ${skill_output} (no dot path) is handled by pre-substituting the string form
    // before handing to interpolateObject (which only resolves scope.path patterns).
    let skill_output_raw: unknown

    for (const action of actions) {
      // Build the interpolation context. skill_output must be an object for path-based
      // lookups; primitives are wrapped under { value } so ${skill_output.value} works.
      const skillOutputObj: Record<string, unknown> | undefined =
        skill_output_raw === undefined
          ? undefined
          : typeof skill_output_raw === 'object' && skill_output_raw !== null
          ? (skill_output_raw as Record<string, unknown>)
          : { value: skill_output_raw }

      const interpCtx = {
        ...ctx,
        ...(skillOutputObj !== undefined ? { skill_output: skillOutputObj } : {}),
      }

      // Pre-substitute bare ${skill_output} (no dot) with the string form of the raw value,
      // since VAR_REGEX in interp.ts requires a dot-separated scope.path format.
      let rawArgs = action.args as Record<string, unknown>
      if (skill_output_raw !== undefined) {
        const serialized = JSON.stringify(rawArgs).replace(
          /\$\{skill_output\}/g,
          String(skill_output_raw)
        )
        rawArgs = JSON.parse(serialized)
      }

      const args = interpolateObject(rawArgs, interpCtx as any) as Record<string, unknown>

      try {
        if (INTENT_ACTIONS.has(action.action)) {
          const entry = this.deps.intentRegistry.get(action.action)
          if (!entry) throw new Error(`intent not registered: ${action.action}`)
          await entry.handler(args)
        } else if (action.action === 'invoke_skill') {
          const r = await this.deps.skillDispatcher.invoke(
            args.slug as string,
            (args.args as Record<string, unknown>) ?? {}
          )
          if (!r.ok) throw new Error(r.error ?? 'skill failed')
          skill_output_raw = r.output
        } else if (action.action === 'composio_tool') {
          if (!this.deps.composio) throw new Error('Composio not configured')
          const toolName = await this.deps.composio.resolver.resolveOrRefresh(
            args.toolkit as string,
            args.tool as string,
          )
          if (!toolName) throw new Error(`could not resolve composio tool '${args.toolkit}:${args.tool}'`)
          const result = await this.deps.composio.executeTool({
            toolName,
            userId: this.deps.composio.userId,
            arguments: (args.args as Record<string, unknown>) ?? {},
          })
          if (result && result.error) throw new Error(String(result.error))
          skill_output_raw = result
        } else if (action.action === 'emit_event') {
          this.deps.eventBus.emit(
            args.name as string,
            (args.payload as Record<string, unknown>) ?? {}
          )
        } else {
          throw new Error(`unknown action: ${(action as Action).action}`)
        }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }

    return {
      ok: true,
      output:
        skill_output_raw !== undefined
          ? typeof skill_output_raw === 'object' && skill_output_raw !== null
            ? (skill_output_raw as Record<string, unknown>)
            : { value: skill_output_raw }
          : undefined,
    }
  }
}

// src/daemon/onboarding/setupIntent.ts
// Factory that creates the `setup_for` Intent + its bound handler.
//
// Design notes:
// - The IntentRegistry stores { intent, handler } separately; `handler` there
//   has signature (args, ctx) => Promise<{ status, details }>.
// - This factory returns a self-contained object whose `handler` takes only
//   `(args)` and returns the full SetupFlowResult — convenient for tests and
//   for the registry wrapper in registerSetupIntent().
// - registerSetupIntent() (below) wraps this into the registry's IntentHandler
//   shape so ActionExecutor can dispatch it normally.

import type { Intent } from '../agency/types'
import type { SetupFlowResult } from './types'
import type { SetupSkillGenerator } from './setupSkillGenerator'
import type { SetupFlowRuntime } from './setupFlowRuntime'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { ActionContext } from '../agency/actionExecutor'

export type SetupIntentDeps = {
  generator: Pick<SetupSkillGenerator, 'generate'>
  runtime: Pick<SetupFlowRuntime, 'run'>
}

export type SetupIntentObject = {
  id: string
  tier: Intent['tier']
  description: string
  argSchema: Intent['argSchema']
  handler: (args: { service_name: string }) => Promise<SetupFlowResult>
}

/** The static Intent descriptor — registered in IntentRegistry. */
export const setupIntentDescriptor: Intent = {
  id: 'setup_for',
  description:
    "Set up an integration with a service the user named (e.g. 'github', 'slack', 'filesystem'). Triggers an LLM-generated onboarding flow.",
  tier: 'GREEN',
  argSchema: { service_name: 'string' },
}

/**
 * Creates a self-contained setup intent object with handler bound to deps.
 * The returned `handler` takes only `{ service_name }` and returns SetupFlowResult.
 * Use `registerSetupIntent()` to wire this into an IntentRegistry.
 */
export function createSetupIntent(deps: SetupIntentDeps): SetupIntentObject {
  const { generator, runtime } = deps

  async function handler(args: { service_name: string }): Promise<SetupFlowResult> {
    if (
      !args ||
      typeof args.service_name !== 'string' ||
      args.service_name.trim() === ''
    ) {
      throw new Error('setup_for: service_name is required and must be a non-empty string')
    }

    const skill = await generator.generate(args.service_name)
    return runtime.run(skill)
  }

  return {
    id: setupIntentDescriptor.id,
    tier: setupIntentDescriptor.tier,
    description: setupIntentDescriptor.description,
    argSchema: setupIntentDescriptor.argSchema,
    handler,
  }
}

/**
 * Registers the setup_for intent into an IntentRegistry.
 * Call this during daemon boot, after SetupSkillGenerator + SetupFlowRuntime
 * are constructed (deps are heavy — they need ModelRouter, McpHost, etc.).
 *
 * Why not in registerBuiltIns()?
 * registerBuiltIns() is dep-free (built-in intents use ctx: ActionContext for
 * any runtime deps). SetupFlowRuntime + SetupSkillGenerator are heavyweight
 * objects that must be constructed separately, so registration is lifted here.
 */
export function registerSetupIntent(
  registry: IntentRegistry,
  deps: SetupIntentDeps,
): void {
  const obj = createSetupIntent(deps)

  // Wrap the factory handler into the registry's IntentHandler shape:
  // (args, ctx) => Promise<{ status, details }>
  registry.register(setupIntentDescriptor, async (
    args: Record<string, unknown>,
    _ctx: ActionContext,
  ) => {
    const result = await obj.handler(args as { service_name: string })
    return {
      status: result.status === 'success' ? 'success' : 'failure' as const,
      details: result.status === 'success'
        ? `Setup complete for '${result.service_name}' (${result.steps_completed}/${result.steps_total} steps)`
        : `Setup failed for '${result.service_name}': ${result.error ?? 'unknown error'}`,
    }
  })
}

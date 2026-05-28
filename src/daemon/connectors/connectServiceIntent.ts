// src/daemon/connectors/connectServiceIntent.ts
// Factory that creates the `connect_service` Intent + its bound handler.
//
// Mirrors the setupIntent pattern from C.2.5 (src/daemon/onboarding/setupIntent.ts).
// GREEN tier: user explicitly asked for connection setup — interactive, not a surprise.

import type { Intent } from '../agency/types'
import type { ConnectFlowResult, ToolkitSlug } from './types'
import type { ConnectionFlow } from './connectionFlow'
import type { ComposioSessionManager } from './composioSessionManager'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { ActionContext } from '../agency/actionExecutor'

export type ConnectServiceIntentDeps = {
  connectionFlow: Pick<ConnectionFlow, 'connect'>
  sessionManager: Pick<ComposioSessionManager, 'addToolkit'>
  userId?: string   // defaults to 'local' for single-user daemon
}

export type ConnectServiceIntentObject = {
  id: string
  tier: Intent['tier']
  description: string
  argSchema: Intent['argSchema']
  handler: (args: { toolkit_slug: ToolkitSlug }) => Promise<ConnectFlowResult>
}

/** The static Intent descriptor — registered in IntentRegistry. */
export const connectServiceIntentDescriptor: Intent = {
  id: 'connect_service',
  description:
    'Connect a new third-party service (Slack, Gmail, GitHub, etc.) to KAIROS via Composio managed OAuth.',
  tier: 'GREEN',
  argSchema: { toolkit_slug: 'string' },
}

/**
 * Creates a self-contained connect_service intent object with handler bound to deps.
 * The returned `handler` takes only `{ toolkit_slug }` and returns ConnectFlowResult.
 * Use `registerConnectServiceIntent()` to wire this into an IntentRegistry.
 */
export function createConnectServiceIntent(
  deps: ConnectServiceIntentDeps,
): ConnectServiceIntentObject {
  async function handler(args: { toolkit_slug: ToolkitSlug }): Promise<ConnectFlowResult> {
    if (!args.toolkit_slug || typeof args.toolkit_slug !== 'string') {
      throw new Error(
        'connect_service: toolkit_slug is required and must be a non-empty string',
      )
    }

    const result = await deps.connectionFlow.connect({
      userId: deps.userId ?? 'local',
      toolkitSlug: args.toolkit_slug,
    })

    if (result.status === 'success') {
      await deps.sessionManager.addToolkit(args.toolkit_slug)
    }

    return result
  }

  return {
    id: connectServiceIntentDescriptor.id,
    tier: connectServiceIntentDescriptor.tier,
    description: connectServiceIntentDescriptor.description,
    argSchema: connectServiceIntentDescriptor.argSchema,
    handler,
  }
}

/**
 * Registers the connect_service intent into an IntentRegistry.
 * Call this during daemon boot, after ConnectionFlow + ComposioSessionManager
 * are constructed.
 *
 * Mirrors registerSetupIntent() from src/daemon/onboarding/setupIntent.ts.
 */
export function registerConnectServiceIntent(
  registry: IntentRegistry,
  deps: ConnectServiceIntentDeps,
): void {
  const obj = createConnectServiceIntent(deps)

  // Wrap the factory handler into the registry's IntentHandler shape:
  // (args, ctx) => Promise<{ status, details }>
  registry.register(connectServiceIntentDescriptor, async (
    args: Record<string, unknown>,
    _ctx: ActionContext,
  ) => {
    const result = await obj.handler(args as { toolkit_slug: ToolkitSlug })
    return {
      status: result.status === 'success' ? 'success' : 'failure' as const,
      details: result.status === 'success'
        ? `Connected '${result.toolkit_slug}' successfully (connection_id=${result.connection_id ?? 'n/a'}, ${result.duration_ms}ms)`
        : `Failed to connect '${result.toolkit_slug}': ${result.error ?? 'unknown error'}`,
    }
  })
}

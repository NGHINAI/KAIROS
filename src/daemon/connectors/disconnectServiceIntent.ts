// src/daemon/connectors/disconnectServiceIntent.ts
// Factory that creates the `disconnect_service` Intent + its bound handler.
//
// Mirrors the connectServiceIntent pattern (C.2.7 Task 8).
// GREEN tier: user explicitly asked to disconnect a service — interactive, not a surprise.

import type { Intent } from '../agency/types'
import type { ToolkitSlug } from './types'
import type { ConnectionStore } from './connectionStore'
import type { ComposioSessionManager } from './composioSessionManager'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { ActionContext } from '../agency/actionExecutor'

export type DisconnectServiceIntentDeps = {
  composio: { deleteConnection(connectionId: string): Promise<void> }
  connectionStore: Pick<ConnectionStore, 'getByToolkit' | 'remove'>
  sessionManager: Pick<ComposioSessionManager, 'removeToolkit'>
  userId?: string   // defaults to 'local' for single-user daemon
}

export type DisconnectServiceIntentObject = {
  id: string
  tier: Intent['tier']
  description: string
  argSchema: Intent['argSchema']
  handler: (args: { toolkit_slug: ToolkitSlug }) => Promise<{ ok: boolean; toolkit_slug: ToolkitSlug; error?: string }>
}

/** The static Intent descriptor — registered in IntentRegistry. */
export const disconnectServiceIntentDescriptor: Intent = {
  id: 'disconnect_service',
  description:
    'Disconnect a previously-connected third-party service. Removes the OAuth token at Composio and the local record.',
  tier: 'GREEN',
  argSchema: { toolkit_slug: 'string' },
}

/**
 * Creates a self-contained disconnect_service intent object with handler bound to deps.
 * The returned `handler` takes only `{ toolkit_slug }` and returns { ok, toolkit_slug, error? }.
 * Use `registerDisconnectServiceIntent()` to wire this into an IntentRegistry.
 */
export function createDisconnectServiceIntent(
  deps: DisconnectServiceIntentDeps,
): DisconnectServiceIntentObject {
  async function handler(args: { toolkit_slug: ToolkitSlug }): Promise<{ ok: boolean; toolkit_slug: ToolkitSlug; error?: string }> {
    if (!args.toolkit_slug || typeof args.toolkit_slug !== 'string') {
      throw new Error(
        'disconnect_service: toolkit_slug is required and must be a non-empty string',
      )
    }

    const userId = deps.userId ?? 'local'
    const connection = deps.connectionStore.getByToolkit(userId, args.toolkit_slug)

    if (!connection) {
      return {
        ok: false,
        toolkit_slug: args.toolkit_slug,
        error: 'no active connection for that toolkit',
      }
    }

    // Best-effort cleanup: attempt Composio deletion first, but continue to local cleanup if it fails.
    let composioError: string | undefined
    try {
      await deps.composio.deleteConnection(connection.connection_id)
    } catch (err) {
      composioError = err instanceof Error ? err.message : String(err)
    }

    // Always remove locally to prevent stale records.
    try {
      deps.connectionStore.remove(userId, args.toolkit_slug)
    } catch (err) {
      // Even if local remove fails, return error from Composio if it failed.
      if (composioError) {
        return {
          ok: false,
          toolkit_slug: args.toolkit_slug,
          error: `Composio deletion failed: ${composioError}. Local cleanup also failed.`,
        }
      }
      return {
        ok: false,
        toolkit_slug: args.toolkit_slug,
        error: `Local cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // Attempt session manager removal.
    try {
      await deps.sessionManager.removeToolkit(args.toolkit_slug)
    } catch (err) {
      // Session manager failure is non-fatal — main cleanup (Composio + local) succeeded.
      // If Composio failed, return that error; otherwise return session manager error.
      if (composioError) {
        return {
          ok: false,
          toolkit_slug: args.toolkit_slug,
          error: `Composio deletion failed: ${composioError}. Local cleanup succeeded.`,
        }
      }
      return {
        ok: false,
        toolkit_slug: args.toolkit_slug,
        error: `Session manager removal failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    // All steps succeeded.
    if (composioError) {
      return {
        ok: false,
        toolkit_slug: args.toolkit_slug,
        error: `Composio deletion failed: ${composioError}. Local cleanup completed.`,
      }
    }

    return {
      ok: true,
      toolkit_slug: args.toolkit_slug,
    }
  }

  return {
    id: disconnectServiceIntentDescriptor.id,
    tier: disconnectServiceIntentDescriptor.tier,
    description: disconnectServiceIntentDescriptor.description,
    argSchema: disconnectServiceIntentDescriptor.argSchema,
    handler,
  }
}

/**
 * Registers the disconnect_service intent into an IntentRegistry.
 * Call this during daemon boot, after ConnectionStore + ComposioSessionManager
 * are constructed.
 *
 * Mirrors registerConnectServiceIntent() from src/daemon/connectors/connectServiceIntent.ts.
 */
export function registerDisconnectServiceIntent(
  registry: IntentRegistry,
  deps: DisconnectServiceIntentDeps,
): void {
  const obj = createDisconnectServiceIntent(deps)

  // Wrap the factory handler into the registry's IntentHandler shape:
  // (args, ctx) => Promise<{ status, details }>
  registry.register(disconnectServiceIntentDescriptor, async (
    args: Record<string, unknown>,
    _ctx: ActionContext,
  ) => {
    const result = await obj.handler(args as { toolkit_slug: ToolkitSlug })
    return {
      status: result.ok ? 'success' : 'failure' as const,
      details: result.ok
        ? `Disconnected '${result.toolkit_slug}' successfully`
        : `Failed to disconnect '${result.toolkit_slug}': ${result.error ?? 'unknown error'}`,
    }
  })
}

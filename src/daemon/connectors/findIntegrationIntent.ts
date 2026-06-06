// src/daemon/connectors/findIntegrationIntent.ts
// Factory that creates the `find_integration` Intent + its bound handler.
//
// GREEN tier: a pure, read-only lookup — given a fuzzy phrase ("calendar",
// "the thing I use for tickets", "a chicken delivery app") it searches the LIVE
// Composio catalog and returns candidate toolkit slugs. The smart-tier Planner
// calls this (via intentsAsTools), sees the list, then calls `connect_service`
// with the REAL slug. Mirrors connectServiceIntent's register pattern.

import type { Intent } from '../agency/types'
import type { ToolkitResolver, ToolkitResolveResult } from './toolkitResolver'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { ActionContext } from '../agency/actionExecutor'

export type FindIntegrationIntentDeps = {
  toolkitResolver: Pick<ToolkitResolver, 'resolve'>
}

export type FindIntegrationResult = ToolkitResolveResult

export type FindIntegrationIntentObject = {
  id: string
  tier: Intent['tier']
  description: string
  argSchema: Intent['argSchema']
  handler: (args: { phrase: string }) => Promise<FindIntegrationResult>
}

/** The static Intent descriptor — registered in IntentRegistry. */
export const findIntegrationIntentDescriptor: Intent = {
  id: 'find_integration',
  description:
    'Find the right third-party integration (Composio toolkit) for a fuzzy phrase. ' +
    'Use this FIRST when the user names a service loosely ("calendar", "the app I use for tickets", ' +
    '"a chicken delivery app") to discover the exact toolkit slug. Returns ranked candidates; ' +
    'then call connect_service with the chosen slug.',
  tier: 'GREEN',
  argSchema: { phrase: 'string' },
}

/**
 * Creates a self-contained find_integration intent object with handler bound to deps.
 * The returned `handler` takes only `{ phrase }` and returns the resolve result.
 * Use `registerFindIntegrationIntent()` to wire this into an IntentRegistry.
 */
export function createFindIntegrationIntent(
  deps: FindIntegrationIntentDeps,
): FindIntegrationIntentObject {
  async function handler(args: { phrase: string }): Promise<FindIntegrationResult> {
    if (!args || typeof args.phrase !== 'string' || args.phrase.trim() === '') {
      throw new Error('find_integration: phrase is required and must be a non-empty string')
    }
    // resolve() never throws — on total failure it returns { matches: [] }.
    return deps.toolkitResolver.resolve(args.phrase)
  }

  return {
    id: findIntegrationIntentDescriptor.id,
    tier: findIntegrationIntentDescriptor.tier,
    description: findIntegrationIntentDescriptor.description,
    argSchema: findIntegrationIntentDescriptor.argSchema,
    handler,
  }
}

/**
 * Registers the find_integration intent into an IntentRegistry.
 * Call this during daemon boot, after ToolkitResolver is constructed.
 * Mirrors registerConnectServiceIntent().
 */
export function registerFindIntegrationIntent(
  registry: IntentRegistry,
  deps: FindIntegrationIntentDeps,
): void {
  const obj = createFindIntegrationIntent(deps)

  registry.register(findIntegrationIntentDescriptor, async (
    args: Record<string, unknown>,
    _ctx: ActionContext,
  ) => {
    const result = await obj.handler(args as { phrase: string })
    if (result.matches.length === 0) {
      return {
        status: 'success' as const,
        details: `No matching integration found. (No Composio toolkit matched the phrase.)`,
      }
    }
    const summary = result.matches
      .map((m) => `${m.slug}${m.name && m.name !== m.slug ? ` (${m.name})` : ''} [score ${(typeof m.score === 'number' ? m.score : 0).toFixed(2)}]`)
      .join(', ')
    const best = result.best ?? result.matches[0]?.slug ?? 'unknown' // never surface literal "undefined" to the planner
    return {
      status: 'success' as const,
      details: `Best match: ${best}. Candidates: ${summary}`,
    }
  })
}

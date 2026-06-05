// src/daemon/connectors/connectServiceIntent.ts
// Factory that creates the `connect_service` Intent + its bound handler.
//
// Mirrors the setupIntent pattern from C.2.5 (src/daemon/onboarding/setupIntent.ts).
// GREEN tier: user explicitly asked for connection setup — interactive, not a surprise.

import type { Intent } from '../agency/types'
import type { ConnectFlowResult, ToolkitSlug } from './types'
import type { ConnectionFlow } from './connectionFlow'
import type { ComposioSessionManager } from './composioSessionManager'
import type { ToolkitResolver } from './toolkitResolver'
import type { IntentRegistry } from '../agency/intentRegistry'
import type { ActionContext } from '../agency/actionExecutor'

/** If the 2nd-best score is within this of a non-exact best, the result is a tie →
 *  ask the user which to connect (instead of silently picking the first). A clear
 *  winner (gap larger than this) connects directly and logs the alternatives. */
const AMBIGUITY_GAP = 0.15

export type ConnectServiceIntentDeps = {
  connectionFlow: Pick<ConnectionFlow, 'connect'>
  sessionManager: Pick<ComposioSessionManager, 'addToolkit'>
  /** Live-catalog toolkit resolver. Replaces the old SLUG_ALIASES map: a fuzzy
   *  toolkit_slug ("calendar", "google-calendar") is resolved to the EXACT slug
   *  before connect (connectionFlow.connect requires an exact slug or it 404s). */
  toolkitResolver: Pick<ToolkitResolver, 'resolve'>
  userId?: string   // defaults to 'local' for single-user daemon
  /** Optional sink for the "picked X, alternatives were Y" note. Defaults to no-op. */
  log?: (msg: string) => void
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
  const logFn = deps.log ?? (() => {})

  async function handler(args: { toolkit_slug: ToolkitSlug }): Promise<ConnectFlowResult> {
    if (!args.toolkit_slug || typeof args.toolkit_slug !== 'string' || !args.toolkit_slug.trim()) {
      throw new Error(
        'connect_service: toolkit_slug is required and must be a non-empty string',
      )
    }

    // The model says "calendar"/"google-calendar"/"gcal"; Composio's real slug is
    // "googlecalendar". Resolve against the LIVE catalog so a request connects on the
    // FIRST try (a wrong slug → 404 → a retry the restraint cooldown then suppresses).
    // An exact slug like 'slack' resolves to itself with score 1 → connects directly.
    const slug = await resolveSlug(deps, args.toolkit_slug, logFn)
    if (typeof slug !== 'string') {
      // Ambiguous — return candidates for the model to relay for confirmation.
      return slug
    }

    const result = await deps.connectionFlow.connect({
      userId: deps.userId ?? 'local',
      toolkitSlug: slug,
    })

    if (result.status === 'success') {
      await deps.sessionManager.addToolkit(slug)
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
 * Resolve a possibly-fuzzy toolkit_slug to an EXACT catalog slug.
 * Returns:
 *  - a `string` exact slug when we're confident enough to connect, OR
 *  - a `ConnectFlowResult` with status 'needs_disambiguation' when several
 *    candidates are plausibly tied (the caller relays it for confirmation).
 *
 * Rules:
 *  - Best match with score >= HIGH_CONFIDENCE and no near-tied runner-up → connect.
 *  - A unique-enough top match below HIGH_CONFIDENCE still connects, but the
 *    alternatives are logged (keeps backward-compat: a single fuzzy phrase still
 *    connects on the first try rather than stalling).
 *  - Best and 2nd-best within AMBIGUITY_GAP → needs_disambiguation.
 */
async function resolveSlug(
  deps: ConnectServiceIntentDeps,
  rawSlug: string,
  logFn: (msg: string) => void,
): Promise<string | ConnectFlowResult> {
  const { matches, best } = await deps.toolkitResolver.resolve(rawSlug)

  // No live/catalog signal at all — fall back to the literal phrase, normalized to
  // a slug-ish form. Better to attempt a connect (which may 404) than to do nothing.
  if (!best || matches.length === 0) {
    return String(rawSlug).trim().toLowerCase().replace(/[^a-z0-9]+/g, '')
  }

  const top = matches[0]!
  const runnerUp = matches[1]

  // A runner-up within AMBIGUITY_GAP of a non-exact top = a genuine tie → ask which,
  // REGARDLESS of absolute score. (The old `&& top.score < HIGH_CONFIDENCE` let two
  // toolkits tied at 0.8 through, silently connecting the alphabetically-first.)
  const ambiguous =
    !!runnerUp && top.score < 1 && (top.score - runnerUp.score) <= AMBIGUITY_GAP

  if (ambiguous) {
    return {
      status: 'needs_disambiguation',
      toolkit_slug: top.slug,
      duration_ms: 0,
      candidates: matches.map((m) => ({
        slug: m.slug,
        name: m.name,
        description: m.description,
        score: m.score,
      })),
    }
  }

  if (matches.length > 1) {
    const alts = matches.slice(1).map((m) => m.slug).join(', ')
    logFn(`[connect_service] resolved '${rawSlug}' → '${top.slug}' (alternatives: ${alts})`)
  }
  return top.slug
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
    if (result.status === 'success') {
      return {
        status: 'success' as const,
        details: `Connected '${result.toolkit_slug}' successfully (connection_id=${result.connection_id ?? 'n/a'}, ${result.duration_ms}ms)`,
      }
    }
    if (result.status === 'needs_disambiguation') {
      const list = (result.candidates ?? [])
        .map((c) => `${c.slug}${c.name && c.name !== c.slug ? ` (${c.name})` : ''}`)
        .join(', ')
      // 'awaiting' — the user must pick before we connect. The model relays the list.
      return {
        status: 'awaiting' as const,
        details: `Several services match that. Which one should I connect: ${list}?`,
      }
    }
    return {
      status: 'failure' as const,
      details: `Failed to connect '${result.toolkit_slug}': ${result.error ?? 'unknown error'}`,
    }
  })
}

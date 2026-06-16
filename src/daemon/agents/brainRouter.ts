// src/daemon/agents/brainRouter.ts
//
// THE DYNAMIC BRAIN ROUTER — dispatches each planning task to the best execution
// engine and falls back when one can't serve. Two engines, same PlannerRunner contract:
//
//   • inhouse  — the in-process loop (defaultPlannerRunner / the background loop).
//                Low latency, always available. The base everything falls back to.
//   • opencode — the warm `opencode serve` agent runtime. Robust for long autonomous
//                runs, but ~18-34s of process/HTTP/proxy overhead → too slow for voice.
//
// POLICY (pickBrain, pure + testable):
//   - INTERACTIVE turns (lane "voice": guidance, teaching, Q&A, memory) → in-house first.
//     The user is waiting; latency wins. opencode is the fallback only if in-house is
//     somehow unavailable.
//   - AUTONOMOUS work (lane "background": spawn_background_task, sub-agents, long
//     multi-tool automation) → opencode first. Nobody's waiting; robustness wins.
//     The proven in-house background loop is the fallback.
//
// FALLBACK is dynamic, not static: if the preferred engine is unavailable, throws, or
// returns nothing for a non-aborted turn, the router transparently delegates to the
// next engine in the preference list. in-house is always last, so a task never dies for
// lack of an engine. ("If an agent cannot come to you, dedicate it to another.")

import type { PlannerRunner } from "./conductor"

export type BrainName = "inhouse" | "opencode"
// The routing axis is GUIDANCE vs everything-else (the user's model): the in-house loop
// owns the latency-critical, HeyClicky-style teaching/guiding path; opencode owns all
// other agentic work (general foreground tasks + autonomous background).
export type Lane = "guidance" | "general"

export interface RouteCtx {
  lane: Lane
  /** Reserved finer hint (e.g. a heavy foreground research turn could prefer opencode). */
  heavy?: boolean
  /** Hard override (KAIROS_BRAIN=inhouse|opencode) — pin this engine first regardless of
   *  lane, for debugging. Ignored if that engine is unavailable. Omitted = dynamic. */
  force?: BrainName
}

/** PURE routing policy: the ordered backend preference for a task, filtered by what's
 *  actually available. in-house is the always-available base, so this is never empty. */
export function pickBrain(ctx: RouteCtx, available: Record<BrainName, boolean>): BrainName[] {
  const base: BrainName[] =
    ctx.lane === "guidance"
      ? ["inhouse", "opencode"] // teaching / guiding (HeyClicky-style) → in-house primary (latency + advanced guide tools)
      : ["opencode", "inhouse"] // everything else (general + autonomous) → opencode primary, in-house fallback
  // A hard override jumps to the front (then the rest stay as fallback).
  const prefer = ctx.force && available[ctx.force] ? [ctx.force, ...base.filter((b) => b !== ctx.force)] : base
  const order = prefer.filter((b) => available[b])
  return order.length ? order : ["inhouse"]
}

export interface BrainBackend {
  name: BrainName
  /** Live health: false when this engine can't currently serve (e.g. opencode serve
   *  failed to spawn / no brain key). Checked per-task so routing adapts at runtime. */
  available: () => boolean
  run: PlannerRunner
}

/** A run that produced nothing usable (and wasn't user-aborted) — treated as a failure
 *  worth falling back on, mirroring the conductor's empty-output guard. */
function isEmptyResult(r: any, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false
  return !(r?.finalOutput && String(r.finalOutput).trim()) && !(r?.toolCalls?.length)
}

export interface BrainRouter {
  /** PlannerRunner-shaped: pass opts.lane to steer; defaults to "voice". */
  run: PlannerRunner
  /** Expose the policy decision for the current availability (observability/tests). */
  pick: (ctx: RouteCtx) => BrainName[]
}

export function createBrainRouter(
  backends: BrainBackend[],
  log?: (m: string) => void,
  routerOpts?: { force?: BrainName },
): BrainRouter {
  const byName = new Map<BrainName, BrainBackend>(backends.map((b) => [b.name, b]))
  const force = routerOpts?.force
  const availability = (): Record<BrainName, boolean> => ({
    inhouse: byName.get("inhouse")?.available() ?? false,
    opencode: byName.get("opencode")?.available() ?? false,
  })

  const run: PlannerRunner = async (input, opts) => {
    // Omitted lane → "guidance" (in-house): the always-available, low-latency safe default.
    const lane: Lane = (opts as any).lane ?? "guidance"
    const order = pickBrain({ lane, heavy: (opts as any).heavy, force }, availability())
    let lastErr: unknown
    for (let i = 0; i < order.length; i++) {
      const backend = byName.get(order[i])
      if (!backend) continue
      const isLast = i === order.length - 1
      const next = order[i + 1]
      try {
        const r = await backend.run(input, opts)
        if (isEmptyResult(r, opts.signal) && !isLast) {
          log?.(`[brain-router] ${order[i]} empty (lane=${lane}) → delegating to ${next}`)
          continue
        }
        return r
      } catch (e) {
        lastErr = e
        if (!isLast) {
          log?.(`[brain-router] ${order[i]} threw "${String((e as Error)?.message ?? e)}" (lane=${lane}) → delegating to ${next}`)
          continue
        }
        throw e
      }
    }
    throw lastErr ?? new Error("brain-router: no engine available")
  }

  return { run, pick: (ctx) => pickBrain({ ...ctx, force: ctx.force ?? force }, availability()) }
}

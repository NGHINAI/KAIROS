// buildActionToolset.ts — THE single source of truth for the agent's action
// toolset. Extracted from index.ts's `actionTools` closure so there is ONE
// assembly, TWO consumers (08): (a) the in-house planner loop (ContextBuilder),
// and (b) the in-process MCP server that Codex connects to. Both call this with
// the SAME deps, guaranteeing byte-identical tools across brains.
//
// Deps are passed EXPLICITLY (not read off globalThis) so this is unit-testable
// and the MCP server can build the toolset without the daemon's global state.

import type { ToolDef } from "./types"
import { intentsAsTools } from "./intentToolBridge"
import { buildToolDispatchTools } from "./toolDispatch"
import { buildBackgroundTools } from "./loop/backgroundTools"
import { buildRecallTool } from "./recallTool"
import { buildWebTools } from "./webTools"
import { buildGuideTools } from "./guideTools"
import { buildCuaTools } from "./cuaTool"

/** Live daemon singletons + knobs the toolset needs. All optional — a missing
 *  dep just omits its tools (matching the original closure's graceful degradation). */
export interface ActionToolDeps {
  intentRegistry?: any
  intentDispatch?: any
  toolRetriever?: any
  composioExecute?: ((name: string, args: any) => Promise<any>) | undefined
  toolUsage?: any
  backgroundManager?: any
  memoryInjector?: any
  guideBridge?: any
  guideLesson?: any
  /** CUA (vision/pixel) computer-use backup — additive on AX. Wired by the daemon
   *  (screencapture + vision-via-/brain + cliclick). Omitted → no cua_click tool. */
  cua?: import("./cuaTool").CuaDeps
  /** Launch a macOS app by name (argv-only `open -a`); wired by the daemon. */
  openApp?: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** false disables web_search/read_webpage (KAIROS_WEB_SEARCH=0). Default true. */
  webSearchEnabled?: boolean
  /** Hot-set size (KAIROS_HOT_TOOLS). Default 5. */
  hotToolsN?: number
  /** Non-throwing logger; defaults to console.warn-style noop-safe. */
  log?: (msg: string, level?: string) => void
}

const HIDDEN_INTENTS = new Set(["add_to_memory", "log", "suspend", "notify"])

/** Assemble the full action toolset. Identical output shape + ordering to the
 *  original index.ts closure; de-duped by name. */
export async function buildActionToolset(deps: ActionToolDeps): Promise<ToolDef[]> {
  const log = deps.log ?? (() => {})
  const out: ToolDef[] = []

  // 1. Agency intents (connect_service, disconnect_service, setup_for, remind_in,
  //    MCP tools). Hidden: add_to_memory (automatic), log/suspend/notify (internal).
  if (deps.intentRegistry && deps.intentDispatch) {
    try {
      out.push(...intentsAsTools({ registry: deps.intentRegistry, dispatch: deps.intentDispatch, filter: (e: any) => !HIDDEN_INTENTS.has(e.id) }))
    } catch (e) { log("[actionTools] intent bridge failed: " + String(e), "warn") }
  }

  // 2. search_tools + execute_tool — per-turn hybrid retrieval over connected
  //    toolkits (scales to 50+ without context bloat) + the usage-ranked HOT SET.
  if (deps.toolRetriever && deps.composioExecute) {
    const execFn = deps.composioExecute
    try {
      const { searchTool, executeTool } = buildToolDispatchTools({ retriever: deps.toolRetriever, execute: execFn })
      out.push(searchTool, executeTool)
      if (deps.toolUsage && typeof deps.toolRetriever.getByNames === "function") {
        const hotN = deps.hotToolsN ?? 5
        for (const d of deps.toolRetriever.getByNames(deps.toolUsage.topNames(hotN)) as any[]) {
          out.push({
            name: d.name,
            description: d.description,
            parameters: (d.parameters && typeof d.parameters === "object" && d.parameters.type) ? d.parameters : { type: "object", properties: {}, required: [] },
            execute: async (args: any) => execFn(d.name, args ?? {}),
            concurrencySafe: /(_LIST|_GET|_SEARCH|_FETCH|_READ|LIST_|GET_|SEARCH_|FIND_)/i.test(d.name),
          })
        }
      }
    } catch (e) { log("[actionTools] tool dispatch bridge failed: " + String(e), "warn") }
  } else {
    log("[actionTools] search_tools/execute_tool NOT available (Composio subsystem not started?) — planner has no external-app tools", "warn")
  }

  // 3. Background agent lane: spawn_background_task + background_tasks.
  if (deps.backgroundManager) {
    try { out.push(...buildBackgroundTools({ manager: deps.backgroundManager })) }
    catch (e) { log("[actionTools] background tools failed: " + String(e), "warn") }
  }

  // 4. JIT memory recall mid-task.
  if (deps.memoryInjector) {
    try { out.push(buildRecallTool({ injector: deps.memoryInjector })) }
    catch (e) { log("[actionTools] recall_memory failed: " + String(e), "warn") }
  }

  // 5. Web access (free, keyless): web_search + read_webpage. Default on.
  if (deps.webSearchEnabled !== false) {
    try { out.push(...buildWebTools()) }
    catch (e) { log("[actionTools] web tools failed: " + String(e), "warn") }
  }

  // 6. Guide/act mode: guide_user/read_screen/click_element/type_text/etc.
  if (deps.guideBridge) {
    const guideL = deps.guideLesson
    try {
      out.push(...buildGuideTools({
        bridge: deps.guideBridge,
        lesson: guideL ? {
          notePoint: (p: any, note?: string) => guideL.notePointFromTool(p, note),
          noteStepDone: () => guideL.noteStepDone(),
          endLesson: (reason: string) => guideL.endRequestFromModel(reason),
        } : undefined,
        openApp: deps.openApp,
      }))
    } catch (e) { log("[actionTools] guide tools failed: " + String(e), "warn") }
  }

  // 7. CUA vision/pixel backup: cua_click — additive on AX (used only when AX can't
  //    resolve an element). Screenshot → vision-locate → pixel click.
  if (deps.cua) {
    try { out.push(...buildCuaTools(deps.cua)) }
    catch (e) { log("[actionTools] cua tools failed: " + String(e), "warn") }
  }

  const seen = new Set<string>()
  return out.filter((t: any) => t?.name && !seen.has(t.name) && (seen.add(t.name), true))
}

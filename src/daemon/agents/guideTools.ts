// src/daemon/agents/guideTools.ts
// guide_user — the agent's hand on the user's screen. When the user asks WHERE
// something is or HOW to do something in an app, the agent calls this per step:
// the orb morphs into a small guide that flies to the element (resolved via the
// Accessibility tree — no screenshots, sub-second) and pulses a highlight while
// the agent talks the user through it. Read-only: it POINTS, it never clicks.

import type { ToolDef } from "./types"
import type { GuideBridge } from "./guideBridge"

export interface GuideToolsDeps {
  bridge: Pick<GuideBridge, "request" | "click">
  /** Launch (or focus) a macOS app by name — `open -a <name>` via argv (no shell). */
  openApp?: (name: string) => Promise<{ ok: boolean; error?: string }>
}

export function buildGuideTools(deps: GuideToolsDeps): ToolDef[] {
  const guideUser: ToolDef = {
    name: "guide_user",
    concurrencySafe: false, // one pointer, one place at a time — steps are sequential
    description:
      "Visually point at a UI element on the USER'S screen: the orb transforms into an on-screen guide that flies " +
      "to the element and highlights it while you talk. Works in ANY app — windows, menu bar menus ('File'), " +
      "the Dock (app='Dock' for Dock icons/Trash), Finder, System Settings. If the app isn't running it opens it " +
      "automatically. For TEACHING a workflow ('teach me X in Photoshop', 'walk me through Y'): go step by step — " +
      "ONE guide_user call per step, SPEAK the instruction, then wait for the user's 'done/next' before the next step. " +
      "It only points — the USER does the clicking.",
    parameters: {
      type: "object",
      properties: {
        find: { type: "string", description: "The element's visible label/title as the user sees it (e.g. 'Export…', 'the Privacy & Security row', 'the Reply button')" },
        app: { type: "string", description: "App to look in (e.g. 'System Settings', 'Mail'). Omit for the frontmost app." },
      },
      required: ["find"],
    },
    execute: async (args: { find: string; app?: string }) => {
      const find = String(args?.find ?? "").trim()
      const app = args?.app?.trim() || undefined
      if (!find) return "Tell guide_user WHAT to point at — the element's visible label."
      let result
      try {
        result = await deps.bridge.request({ find, app })
      } catch {
        result = null
      }
      // SELF-HEALING: target app not running → open it OURSELVES and retry once.
      // Deterministic tool-level chaining — models reliably fumbled the two-step
      // dance (open_app … then re-call guide_user) even when told explicitly.
      if (result && !result.found && app && deps.openApp && /no running app/i.test(result.reason ?? "")) {
        const opened = await deps.openApp(app)
        if (opened.ok) {
          await new Promise((r) => setTimeout(r, 2200))   // app launch + AX tree settle
          try { result = await deps.bridge.request({ find, app }) } catch { result = null }
        }
      }
      if (result == null) {
        return (
          "The on-screen guide isn't available right now (the HUD isn't running or can't see the screen). " +
          "Guide the user VERBALLY instead — describe exactly where to look and what to click."
        )
      }
      if (!result.found) {
        const appNotRunning = /no running app/i.test(result.reason ?? "")
        return (
          `Couldn't find "${find}" on screen${result.reason ? ` (${result.reason})` : ""}. ` +
          (appNotRunning
            ? "Call open_app to launch the app YOURSELF, then call guide_user again — don't make the user open it."
            : "Try the element's exact visible wording (open_app can bring the app forward), or guide the user verbally for this step.")
        )
      }
      return (
        `Pointing at "${result.label ?? find}" now — the user can see the highlight. ` +
        "Speak this step's instruction, then continue to the next step or wrap up."
      )
    },
  }

  const openApp: ToolDef = {
    name: "open_app",
    concurrencySafe: false,
    description:
      "Open (or bring forward) a macOS app by name — e.g. 'System Settings', 'Mail', 'Safari'. " +
      "Use it BEFORE guide_user when the app you need to point into isn't running; never ask the user to open an app you can open yourself.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The app's name as it appears in /Applications (e.g. 'System Settings')" },
      },
      required: ["name"],
    },
    execute: async (args: { name: string }) => {
      const name = String(args?.name ?? "").trim()
      if (!name) return "Tell open_app WHICH app to open."
      if (!deps.openApp) return "App launching isn't available in this environment — ask the user to open it."
      const r = await deps.openApp(name)
      if (!r.ok) return `Couldn't open "${name}"${r.error ? ` (${r.error})` : ""}. Check the app's exact name or ask the user.`
      return (
        `"${name}" is open. NOW call guide_user with the element the user originally asked about — ` +
        `you already know what they want; do NOT ask them what to look for, and do NOT end the turn yet.`
      )
    },
  }

  const clickElement: ToolDef = {
    name: "click_element",
    concurrencySafe: false,
    description:
      "Actually CLICK a UI element for the user (button, link, menu item, checkbox, toggle) — the orb's comet " +
      "flies to it and presses it via the accessibility action (no cursor moves, no window stealing). " +
      "Works in any app AND in Safari/Chrome web pages (click a link/button by its visible text). " +
      "Use when the user wants the thing DONE, not just shown ('click Subscribe', 'turn on Dark Mode', 'open the File menu'). " +
      "For system/app settings like volume or playback, prefer run_applescript.",
    parameters: {
      type: "object",
      properties: {
        find: { type: "string", description: "The element's visible label (e.g. 'Subscribe', 'Wi-Fi', 'Send')" },
        app: { type: "string", description: "App to act in (e.g. 'Safari', 'System Settings'). Omit for the frontmost app." },
      },
      required: ["find"],
    },
    execute: async (args: { find: string; app?: string }) => {
      const find = String(args?.find ?? "").trim()
      const app = args?.app?.trim() || undefined
      if (!find) return "Tell click_element WHAT to click — the element's visible label."
      let result
      try { result = await deps.bridge.click({ find, app }) }
      catch { result = null }
      // Self-heal: app not running → open it, retry once.
      if (result && !result.found && app && deps.openApp && /no running app/i.test(result.reason ?? "")) {
        const opened = await deps.openApp(app)
        if (opened.ok) { await new Promise((r) => setTimeout(r, 2200)); try { result = await deps.bridge.click({ find, app }) } catch { result = null } }
      }
      if (result == null) {
        return "Clicking isn't available right now (the HUD isn't running or can't see the screen). Tell the user what to click instead."
      }
      if (!result.found) {
        return `Couldn't click "${find}"${result.reason ? ` (${result.reason})` : ""}. Use the exact visible label, make sure it's on screen, or guide the user verbally.`
      }
      return `Clicked "${result.label ?? find}". Confirm what happened and continue.`
    },
  }

  const tools: ToolDef[] = [guideUser, clickElement]
  if (deps.openApp) tools.push(openApp)
  return tools
}

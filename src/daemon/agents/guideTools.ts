// src/daemon/agents/guideTools.ts
// guide_user — the agent's hand on the user's screen. When the user asks WHERE
// something is or HOW to do something in an app, the agent calls this per step:
// the orb morphs into a small guide that flies to the element (resolved via the
// Accessibility tree — no screenshots, sub-second) and pulses a highlight while
// the agent talks the user through it. Read-only: it POINTS, it never clicks.

import type { ToolDef } from "./types"
import type { GuideBridge } from "./guideBridge"
import type { LessonPoint } from "./guideLesson"

export interface GuideToolsDeps {
  bridge: Pick<GuideBridge, "request"> &
    Partial<Pick<GuideBridge, "requestScreen" | "requestWatch" | "requestAct" | "requestScroll">>
  /** Launch (or focus) a macOS app by name — `open -a <name>` via argv (no shell). */
  openApp?: (name: string) => Promise<{ ok: boolean; error?: string }>
  /** Guide session hooks (GuideLessonManager): successful points feed the durable
   *  lesson/highlight state; end_lesson is only registered when these are wired.
   *  endLesson returns false when the manager REFUSES (no step completed yet). */
  lesson?: {
    notePoint: (point: LessonPoint, stepNote?: string) => void
    noteStepDone: () => void
    endLesson: (reason: string) => boolean
  }
}

/** Labels whose click is hard to take back — the HUD refuses to press these until
 *  the model re-calls with confirm:true (i.e. after asking the user out loud). The
 *  daemon owns the pattern; the HUD applies it to the RESOLVED label pre-press. */
export const DANGEROUS_LABEL_RE =
  /\b(delete|remove|erase|empty|send|pay|purchase|buy|order|subscribe|unsubscribe|sign out|log ?out|shut ?down|restart|format|uninstall|reset|revoke|transfer|publish|post)\b/i

/** The act-mode contract, stamped on both act tools. */
const ACT_PROTOCOL =
  "DO-IT MODE (when the user asks you to DO something on their Mac, not to learn it): " +
  "read_screen → click_element/type_text by NUMBER → read_screen to VERIFY the effect → next step. " +
  "Narrate each step in ONE short clause as you do it ('Opening Appearance — now switching to Dark'). " +
  "For TEACHING asks ('teach me / show me how') use guide_user instead — there the USER does the clicking."

/** The walkthrough contract, repeated on every guide tool so the model can't miss it. */
const WALKTHROUGH_PROTOCOL =
  "WALKTHROUGH (for 'teach me / walk me through X') — VOICE-PACED, one step per turn, like a patient teacher: " +
  "(1) read_screen to see what's REALLY there — never guess section names. " +
  "(2) guide_user the element for the CURRENT step, then speak ONE short instruction that ENDS by asking the user to tell you when they're ready — e.g. \"Click Sound, then say 'continue' (or 'I'm ready') and I'll show you the next step.\" " +
  "(3) STOP — end your turn now. Do NOT call wait_for_screen, do NOT narrate what you're doing, do NOT guess or jump to the next step. WAIT for the user. " +
  "(4) When the user says continue / I'm ready / next / okay / go ahead, read_screen again and guide the NEXT step the same way (point, one short instruction, ask them to say continue, stop). " +
  "When the goal is fully done, call end_lesson and wrap up warmly. NEVER advance on your own or rush them — the user paces every step by voice."

export function buildGuideTools(deps: GuideToolsDeps): ToolDef[] {
  // Unchanged-screen detector for read_screen (see the short-circuit below).
  let lastScreenSummary = ""
  let lastScreenAt = 0
  const guideUser: ToolDef = {
    name: "guide_user",
    concurrencySafe: false, // one pointer, one place at a time — steps are sequential
    description:
      "Visually point at a UI element on the USER'S screen: the orb transforms into an on-screen guide that flies " +
      "to the element and highlights it while you talk. Works in ANY app — windows, menu bar menus ('File'), " +
      "the Dock (app='Dock' for Dock icons/Trash), Finder, System Settings. If the app isn't running it opens it " +
      "automatically. It only points — the USER does the clicking. " + WALKTHROUGH_PROTOCOL,
    parameters: {
      type: "object",
      properties: {
        element: { type: "number", description: "PREFERRED: the element's NUMBER from your latest read_screen — exact, grounded pointing" },
        find: { type: "string", description: "Fallback when you haven't read the screen: the element's visible label (e.g. 'Export…', 'Trash')" },
        app: { type: "string", description: "App to look in (e.g. 'System Settings', 'Dock'). Omit for the frontmost app." },
      },
    },
    execute: async (args: { element?: number; find?: string; app?: string }) => {
      const element = Number.isFinite(args?.element) ? Math.round(args!.element!) : undefined
      const find = String(args?.find ?? "").trim()
      const app = args?.app?.trim() || undefined
      if (!element && !find) return "Tell guide_user WHAT to point at — the element NUMBER from read_screen (preferred) or its visible label."
      let result
      try {
        result = await deps.bridge.request({ find: find || undefined, element, app })
      } catch {
        result = null
      }
      // SELF-HEALING: target app not running (or running with its window closed) →
      // open/bring it forward OURSELVES and retry once. Deterministic tool-level
      // chaining — models reliably fumbled the two-step dance even when told.
      if (result && !result.found && app && deps.openApp && /no running app|window is closed/i.test(result.reason ?? "")) {
        const opened = await deps.openApp(app)
        if (opened.ok) {
          await new Promise((r) => setTimeout(r, 2200))   // app launch + AX tree settle
          try { result = await deps.bridge.request({ find: find || undefined, element, app }) } catch { result = null }
        }
      }
      const what = find || `element #${element}`
      if (result == null) {
        return (
          "The on-screen guide isn't available right now (the HUD isn't running or can't see the screen). " +
          "Guide the user VERBALLY instead — describe exactly where to look and what to click."
        )
      }
      if (!result.found) {
        const appNotRunning = /no running app/i.test(result.reason ?? "")
        return (
          `Couldn't find ${what} on screen${result.reason ? ` (${result.reason})` : ""}. ` +
          (appNotRunning
            ? "Call open_app to launch the app YOURSELF, then call guide_user again — don't make the user open it."
            : "Do NOT guess another wording — call read_screen to SEE what's actually visible, then point by its NUMBER. " +
              "If the screen shows the user isn't where you expected (a pane not open yet), guide them to the step that IS visible first.")
        )
      }
      const label = result.label ?? what
      // Feed the durable guide session: lessons survive turns; standalone highlights
      // persist until the user speaks or acts. (No-op when the manager isn't wired.)
      try { deps.lesson?.notePoint({ label, find: find || undefined, element, app }) } catch { /* */ }
      return (
        `Pointing at "${label}" now — the user sees the highlight (it STAYS on screen until they act). Say ONE short line naming it. ` +
        "THEN choose by what the user ASKED:\n" +
        `• LOCATE ("where is…", "show me…", "find…"): pointing at "${label}" IS the answer — say it's right there and END the turn. ` +
        "Do NOT call wait_for_screen, do NOT read_screen again, do NOT invent a next step. The single point completes a locate.\n" +
        `• WALKTHROUGH ("how do I…", "walk me through…", multi-step): give ONE short instruction that ENDS by asking them to say when ready ` +
        `(\"click ${label}, then say 'continue' or 'I'm ready' and I'll show you the next step\"), then END your turn. ` +
        "Do NOT call wait_for_screen and do NOT guess the next step — the user paces it BY VOICE. When they say continue, read_screen and guide the next step. Call end_lesson when the goal's done."
      )
    },
  }

  // ── SCROLL GUIDANCE ─────────────────────────────────────────────────────────
  // When read_screen marks the target as off-screen (e.g. "FileVault [off-screen ↓ —
  // scroll down]"), the element exists in the AX tree but is clipped out of the visible
  // scroll viewport. guide_user can't point at what isn't on screen, so the model shows
  // a directional ARROW + "scroll down/up" pill and lets the USER scroll it into view —
  // then re-reads and points by number. KAIROS never auto-scrolls (guidance doctrine).
  const guideScroll: ToolDef = {
    name: "guide_scroll",
    concurrencySafe: false,
    description:
      "Show the user WHICH WAY to scroll when the thing you want to point at is OFF-SCREEN. " +
      "Call this ONLY after read_screen tagged the target '[off-screen ↓]'/'[off-screen ↑]' (it's in the app but scrolled out of view). " +
      "The orb shows a glowing arrow + a 'scroll down'/'scroll up' cue at the edge of the scroll area — the USER scrolls, you do NOT. " +
      "Say one short line ('scroll down a little — I'll point it out'), then call read_screen AGAIN to re-check; once the target is no longer off-screen, guide_user by its NUMBER. " +
      WALKTHROUGH_PROTOCOL,
    parameters: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"], description: "Which way the user should scroll to reveal the target (from read_screen's off-screen marker: ↓ = down, ↑ = up)" },
        element: { type: "number", description: "The target's NUMBER from read_screen (so the arrow can anchor on its scroll region)" },
        app: { type: "string", description: "App to guide in. Omit for the frontmost app." },
      },
      required: ["direction"],
    },
    execute: async (args: { direction?: string; element?: number; app?: string }) => {
      const direction = args?.direction === "up" || args?.direction === "down" ? args.direction : undefined
      if (!direction) return "Tell guide_scroll the DIRECTION — 'up' or 'down' (read_screen's off-screen marker shows ↑ or ↓)."
      if (!deps.bridge.requestScroll) return "Scroll guidance isn't available right now — just tell the user out loud to scroll that way, then call read_screen again."
      const element = Number.isFinite(args?.element) ? Math.round(args!.element!) : undefined
      let result
      try { result = await deps.bridge.requestScroll({ direction, targetElement: element, app: args?.app?.trim() || undefined }) } catch { result = null }
      if (result == null) {
        return "The on-screen arrow isn't available right now (HUD not running) — tell the user verbally to scroll " + direction + ", then call read_screen again."
      }
      return (
        `Showing a "scroll ${direction}" arrow now. Say ONE short line asking the user to scroll AND to tell you when ready — ` +
        `e.g. "scroll ${direction} a little, then say 'continue' (or 'I'm ready') and I'll point it out." Then END your turn and WAIT. ` +
        "Do NOT call read_screen or guide_scroll again now — the screen won't change until the user scrolls, and re-checking immediately just loops. " +
        "When the user says continue / I'm ready, read_screen again; once the target is no longer off-screen, guide_user at its NUMBER."
      )
    },
  }

  const waitForScreen: ToolDef = {
    name: "wait_for_screen",
    concurrencySafe: false,
    description:
      "WATCH the user's screen until an element appears — i.e. until the user has completed the step you just pointed at " +
      "(clicking 'Appearance' makes 'Light'/'Dark' appear; opening a menu makes its items appear). " +
      "Returns the moment it shows up, so you speak the next step immediately. " + WALKTHROUGH_PROTOCOL,
    parameters: {
      type: "object",
      properties: {
        until: { type: "string", description: "The visible label that will EXIST once the user has done the step (e.g. 'Dark' after clicking Appearance)" },
        app: { type: "string", description: "App to watch (defaults to the one being guided)" },
        timeout_seconds: { type: "number", description: "How long to wait (default 30, max 120) — users take a moment" },
      },
      required: ["until"],
    },
    execute: async (args: { until: string; app?: string; timeout_seconds?: number }) => {
      const until = String(args?.until ?? "").trim()
      if (!until) return "Tell wait_for_screen WHAT should appear once the user has acted."
      if (!deps.bridge.requestWatch) return "Screen watching isn't available — ask the user to say 'done' after each step instead."
      const timeoutMs = Math.min(Math.max((Number(args?.timeout_seconds) || 30), 5), 120) * 1000
      const t0 = Date.now()
      let result
      try {
        result = await deps.bridge.requestWatch({ find: until, app: args?.app?.trim() || undefined, timeoutMs })
      } catch { result = null }
      const elapsedMs = Date.now() - t0
      if (result == null) {
        return "Screen watching isn't available right now — ask the user to tell you when they're done with this step."
      }
      if (!result.found) {
        // The user-paced moment: ~30s without acting. The user chose a GENTLE voice
        // check-in here — one soft line, then quiet. Ending the turn is SAFE now:
        // the highlight persists and the lesson auto-resumes on their next click.
        return (
          `"${until}" hasn't appeared yet${result.reason ? ` (${result.reason})` : ""}. ` +
          "Call read_screen once to check whether they went somewhere else. If they're just taking their time, " +
          "END your turn with ONE gentle check-in line (e.g. \"No rush — it's the highlighted one when you're ready\"). " +
          "Do NOT keep waiting and do NOT repeat instructions — the highlight stays up and the lesson resumes automatically when they act."
        )
      }
      // Instant hit = it was ALREADY on screen — the user hasn't acted yet, you
      // watched for the wrong thing (live bug: wait_for_screen("Appearance") before
      // pointing returned instantly because the sidebar always shows Appearance).
      // TOGGLE-STEP ESCAPE: when the user's NEXT action is clicking something that's
      // already visible (Light/Dark, a checkbox), clicking it creates NO new element
      // — there is nothing to wait for. Without this exit the model looped point→
      // instant-hit→re-read for a full minute (live 2026-06-11).
      if (elapsedMs < 2000) {
        return (
          `"${result.label ?? until}" was ALREADY visible — that's not evidence the user acted. ` +
          "If it's a LATER step, point the CURRENT step first and wait for what appears after it. " +
          `But if clicking "${result.label ?? until}" IS the next step (a toggle/option that's already on screen), ` +
          "point at IT, say plainly that it's the last step, and END your turn — the lesson resumes by itself when they click."
        )
      }
      try { deps.lesson?.noteStepDone() } catch { /* */ }
      return (
        `"${result.label ?? until}" is on screen — the user completed the step. ` +
        "IMMEDIATELY speak the next step and point at its element (guide_user); don't thank them or pause. " +
        "If that was the last step, confirm the goal is done in one short sentence."
      )
    },
  }

  const readScreen: ToolDef = {
    name: "read_screen",
    concurrencySafe: true,
    description:
      "See what's ACTUALLY on the user's screen right now: the visible sections, buttons, menus and controls of an app " +
      "(read from the accessibility tree — instant, no screenshots). Use this to guide DYNAMICALLY: " +
      "call it BEFORE a walkthrough to plan steps from what's really there, and AFTER the user completes a step " +
      "to see the new state. The list is for YOUR planning only — never read it aloud.",
    parameters: {
      type: "object",
      properties: {
        app: { type: "string", description: "App to look at (e.g. 'System Settings', 'Photoshop'). Omit for the frontmost app." },
      },
    },
    execute: async (args: { app?: string }) => {
      if (!deps.bridge.requestScreen) return "Screen reading isn't available right now — guide from your knowledge instead."
      const app = args?.app?.trim() || undefined
      let result
      try { result = await deps.bridge.requestScreen(app) } catch { result = null }
      // One retry on silence: the likeliest cause is an app mid-launch whose AX tree
      // is still settling (not a dead HUD) — give it a beat and look again.
      if (result == null) {
        await new Promise((r) => setTimeout(r, 2500))
        try { result = await deps.bridge.requestScreen(app) } catch { result = null }
      }
      // SELF-HEAL: app not running → open it OURSELVES and look again. Without this,
      // a teach ask with the app closed dead-ended (live 2026-06-11: "no running app
      // called System Settings" → 'guide verbally' → the gate demanded pointing →
      // hedge; the USER had to open Settings and announce it).
      if (result && !result.found && app && deps.openApp && /no running app|window is closed/i.test(result.reason ?? "")) {
        const opened = await deps.openApp(app)
        if (opened.ok) {
          await new Promise((r) => setTimeout(r, 2200))
          try { result = await deps.bridge.requestScreen(app) } catch { result = null }
        }
      }
      // UNCHANGED-SCREEN SHORT-CIRCUIT: re-reading an identical screen returns a
      // demand for ACTION, not the same inventory again (a 20-round read_screen
      // doom-loop shipped one night's lesson nowhere).
      if (result?.found && result.summary && result.summary === lastScreenSummary && Date.now() - lastScreenAt < 30_000) {
        return (
          "The screen has NOT changed since you last looked. Do NOT look again — act NOW on one of the numbered elements: " +
          "click_element({element: N}) if the user asked you to DO it, guide_user({element: N}) if you're showing them, " +
          "or tell the user plainly what to do next."
        )
      }
      if (result?.found && result.summary) { lastScreenSummary = result.summary; lastScreenAt = Date.now() }
      if (result == null) {
        return "Can't see the screen right now (the HUD isn't running). Guide verbally from your knowledge instead."
      }
      if (!result.found || !result.summary) {
        return `Couldn't read the screen${result.reason ? ` (${result.reason})` : ""}. Guide verbally from your knowledge instead.`
      }
      return (
        "CURRENT SCREEN (for your planning ONLY — never read this list to the user; mention at most the one item the next step needs). " +
        "Act by NUMBER: click_element({element: N}) when the user asked you to DO it; guide_user({element: N}) when you're SHOWING them how. " +
        "Pick the element whose label matches the user's GOAL WORDS ('wallpaper' → the Wallpaper item), NOT a path you remember from other lessons. " +
        "If NOTHING here matches the goal, the path runs through a sidebar/section item — use the section that " +
        "would CONTAIN the goal (dark mode → Appearance) and never ask the user what's on their screen. " +
        "If the matching element is tagged [off-screen ↓] or [off-screen ↑], it exists but is scrolled out of view — " +
        "call guide_scroll({direction}) to point the way, have the USER scroll, then read_screen again and guide_user by NUMBER:\n" +
        result.summary
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
        `"${name}" is open. NOW continue toward the user's goal — read_screen, then ` +
        "click_element (when they asked you to DO it) or guide_user (when you're SHOWING them). " +
        "You already know what they want; do NOT ask, and do NOT end the turn yet."
      )
    },
  }

  // ── ACT MODE (computer use) ─────────────────────────────────────────────────
  // The actuation half of the Cua pattern: the comet flies to the element, THEN
  // presses it (kAXPressAction → per-PID CGEvent fallback). The user watches every
  // step land. Element-index/label addressing only — raw coordinates don't exist
  // in this protocol, so the model can't click blind.

  const clickElement: ToolDef = {
    name: "click_element",
    concurrencySafe: false,
    description:
      "CLICK a UI element on the user's Mac YOURSELF (the on-screen comet flies to it, then presses it — " +
      "no cursor movement, no focus stealing). Use when the user asks you to DO something " +
      "(open a pane, switch a setting, pick an option) rather than learn it. " +
      "Prefer {element: N} from your latest read_screen. " + ACT_PROTOCOL,
    parameters: {
      type: "object",
      properties: {
        element: { type: "number", description: "PREFERRED: the element's NUMBER from your latest read_screen" },
        find: { type: "string", description: "Fallback: the element's visible label (e.g. 'Dark', 'Appearance')" },
        app: { type: "string", description: "App to act in (e.g. 'System Settings'). Omit for the frontmost app." },
        confirm: { type: "boolean", description: "true ONLY after the user has verbally approved a risky click (Send/Delete/Buy…)" },
      },
    },
    execute: async (args: { element?: number; find?: string; app?: string; confirm?: boolean }) => {
      if (!deps.bridge.requestAct) return "Acting on screen isn't available right now — guide the user verbally instead."
      const element = Number.isFinite(args?.element) ? Math.round(args!.element!) : undefined
      const find = String(args?.find ?? "").trim() || undefined
      const app = args?.app?.trim() || undefined
      if (!element && !find) return "Tell click_element WHAT to click — the element NUMBER from read_screen (preferred) or its visible label."
      let result
      try {
        result = await deps.bridge.requestAct({
          element, find, app, action: "press",
          confirm: !!args?.confirm, confirmGuard: DANGEROUS_LABEL_RE.source,
        })
      } catch { result = null }
      // Self-heal: target app not running → open it ourselves and retry once.
      if (result && !result.found && app && deps.openApp && /no running app|window is closed/i.test(result.reason ?? "")) {
        const opened = await deps.openApp(app)
        if (opened.ok) {
          await new Promise((r) => setTimeout(r, 2200))
          try {
            result = await deps.bridge.requestAct({
              element, find, app, action: "press",
              confirm: !!args?.confirm, confirmGuard: DANGEROUS_LABEL_RE.source,
            })
          } catch { result = null }
        }
      }
      if (result == null) return "Acting on screen isn't available right now (the HUD isn't running). Guide the user verbally instead."
      if (!result.found) {
        if (/needs_confirm/i.test(result.reason ?? "")) {
          return (
            `STOP — "${result.label}" looks irreversible (it's highlighted on screen now). ` +
            `Ask the user ONE short question ("Should I click ${result.label}?") and END your turn. ` +
            `Only after they say yes, call click_element again with confirm: true.`
          )
        }
        return (
          `Couldn't click ${find ?? `element #${element}`}${result.reason ? ` (${result.reason})` : ""}. ` +
          "Call read_screen to see what's actually there, then act by NUMBER. Don't guess labels."
        )
      }
      // The HUD verifies the act by re-reading the screen: reason carries the
      // strategy-aware verdict. "unchanged" first — it contains "changed".
      if (/unchanged/i.test(result.reason ?? "")) {
        return (
          `Clicked "${result.label}" but the screen did NOT change — the click likely didn't take. ` +
          "Do NOT tell the user it's done. Try a DIFFERENT element: read_screen, then click the more specific " +
          "option (a child item, the exact toggle) — never re-click the same element more than twice."
        )
      }
      try { deps.lesson?.noteStepDone() } catch { /* */ }
      if (/pressed/i.test(result.reason ?? "")) {
        return (
          `Clicked "${result.label}" — pressed OK. Toggles/options often don't change the element list, ` +
          "so this counts as done for that step. Continue to the next step, or confirm completion to the user in one short sentence."
        )
      }
      if (/changed/i.test(result.reason ?? "")) {
        return (
          `Clicked "${result.label}" — the screen CHANGED (it took effect). ` +
          "Call read_screen to see the new state, then continue: next click, or tell the user it's done in one short sentence."
        )
      }
      return (
        `Clicked "${result.label}". NOW call read_screen to verify what changed, then continue ` +
        "(next click, or tell the user it's done in one short sentence). Never claim success without verifying."
      )
    },
  }

  const typeText: ToolDef = {
    name: "type_text",
    concurrencySafe: false,
    description:
      "TYPE text into a field on the user's Mac YOURSELF (sets the field's value directly; falls back to " +
      "keystrokes sent only to that app). Use for search boxes, rename fields, forms — when the user asked " +
      "you to DO it. Prefer {element: N} from read_screen. " + ACT_PROTOCOL,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The text to put in the field" },
        element: { type: "number", description: "PREFERRED: the field's NUMBER from your latest read_screen" },
        find: { type: "string", description: "Fallback: the field's visible label/placeholder (e.g. 'Search')" },
        app: { type: "string", description: "App to act in. Omit for the frontmost app." },
        submit: { type: "boolean", description: "Press Return after typing (search/submit fields)" },
      },
      required: ["text"],
    },
    execute: async (args: { text: string; element?: number; find?: string; app?: string; submit?: boolean }) => {
      if (!deps.bridge.requestAct) return "Acting on screen isn't available right now — guide the user verbally instead."
      const text = String(args?.text ?? "")
      const element = Number.isFinite(args?.element) ? Math.round(args!.element!) : undefined
      const find = String(args?.find ?? "").trim() || undefined
      if (!element && !find) return "Tell type_text WHICH field — the element NUMBER from read_screen (preferred) or its visible label."
      let result
      try {
        result = await deps.bridge.requestAct({
          element, find, app: args?.app?.trim() || undefined,
          action: "set_value", text, submit: !!args?.submit, confirm: true,
        })
      } catch { result = null }
      if (result == null) return "Acting on screen isn't available right now (the HUD isn't running). Guide the user verbally instead."
      if (!result.found) {
        return (
          `Couldn't type into ${find ?? `element #${element}`}${result.reason ? ` (${result.reason})` : ""}. ` +
          "Call read_screen to find the right field, then act by NUMBER."
        )
      }
      return (
        `Typed into "${result.label}"${args?.submit ? " and pressed Return" : ""}. ` +
        "NOW call read_screen to verify the effect, then continue."
      )
    },
  }

  // end_lesson — the model's explicit "goal achieved" signal. Without it, lessons
  // would only die by dismissal phrase or hard cap, leaving the comet out and the
  // auto-continue watcher armed long after "your wallpaper is changed!".
  const endLesson: ToolDef = {
    name: "end_lesson",
    concurrencySafe: false,
    description:
      "End the current guided walkthrough: call this the moment the user's GOAL is fully achieved " +
      "(or they clearly want to stop). The on-screen guide retracts and the orb re-forms. " +
      "Then wrap up with one short, warm line. Never leave a finished lesson open.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      let ended = true
      try { ended = deps.lesson?.endLesson("model declared the goal complete") ?? true } catch { /* */ }
      if (!ended) {
        // The model pointed at the FIRST element and instantly declared victory
        // (live 2026-06-11) — the user hasn't completed a single step yet.
        return (
          "REFUSED — the lesson just started and the user hasn't completed a single step. " +
          "Pointing is not finishing. Speak the current step and call wait_for_screen for its effect; " +
          "end_lesson is for when the GOAL is actually achieved."
        )
      }
      return "Lesson closed — the guide is off screen. Say one short warm wrap-up line (and nothing about lessons or tools)."
    },
  }

  const tools = [guideUser, readScreen]
  // VOICE-PACED by default (HeyClicky model): OMIT wait_for_screen so a walkthrough can't
  // BLOCK the turn auto-detecting a screen change — the brain must instead end the turn and
  // ask the user to say "continue"/"I'm ready", then resume on their word. (Leaving the tool
  // in tempted the model to busy-wait + overshoot within one turn.) The between-turns
  // armAutoContinue still advances on action as a bonus (it uses a different bridge method).
  // Opt back into the old in-turn auto-advance with KAIROS_GUIDE_AUTO_ADVANCE=1.
  if (process.env.KAIROS_GUIDE_AUTO_ADVANCE === "1") tools.push(waitForScreen)
  if (deps.bridge.requestScroll) tools.push(guideScroll)
  if (deps.openApp) tools.push(openApp)
  if (deps.lesson) tools.push(endLesson)
  if (deps.bridge.requestAct) tools.push(clickElement, typeText)
  return tools
}

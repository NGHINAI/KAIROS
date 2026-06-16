// guideLesson.test.ts — the durable guide session: lessons that outlive turns,
// auto-continue on the user's click, voice/act dismissal, watcher staleness.
import { describe, expect, test } from "bun:test"
import { GuideLessonManager, LESSON_DISMISS_RE, LESSON_CONTINUE_SENTINEL, LESSON_CONTINUE_TEXT } from "./guideLesson"

type Deferred = { resolve: (v: boolean) => void; promise: Promise<boolean> }
function deferred(): Deferred {
  let resolve!: (v: boolean) => void
  const promise = new Promise<boolean>((r) => { resolve = r })
  return { resolve, promise }
}

function harness() {
  const watches: Array<{ app: string | undefined; timeoutMs: number; d: Deferred }> = []
  const continued: string[] = []
  let retracts = 0
  const mgr = new GuideLessonManager({
    watchChange: (app, timeoutMs) => {
      const d = deferred()
      watches.push({ app, timeoutMs, d })
      return d.promise
    },
    continueLesson: (cid) => continued.push(cid),
    retractGuide: () => { retracts++ },
  })
  return { mgr, watches, continued, retracted: () => retracts }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe("lesson start/attribution", () => {
  test("a teaching-turn point starts a lesson; a plain point stays standalone", () => {
    const { mgr } = harness()
    mgr.setTurnContext("c1", "show me where the Trash is", false)
    mgr.notePointFromTool({ label: "Trash", app: "Dock" })
    expect(mgr.active).toBeNull()
    expect(mgr.lastPointed()?.label).toBe("Trash")

    mgr.setTurnContext("c1", "teach me how to change my wallpaper", true)
    mgr.notePointFromTool({ label: "Wallpaper", app: "System Settings" })
    expect(mgr.active?.goal).toContain("wallpaper")
    expect(mgr.isActiveFor("c1")).toBe(true)
    // the lesson absorbs the pointer — no stale standalone alongside it
    expect(mgr.lastPointed()?.label).toBe("Wallpaper")
  })

  test("points during a live lesson update the current step (even on non-teaching turns)", () => {
    const { mgr } = harness()
    mgr.setTurnContext("c1", "walk me through dark mode", true)
    mgr.notePointFromTool({ label: "Appearance", app: "System Settings" }, "click Appearance")
    mgr.setTurnContext("c1", "okay I'm in Appearance now, what?", false)
    mgr.notePointFromTool({ label: "Dark", app: "System Settings" })
    expect(mgr.active?.lastPointed?.label).toBe("Dark")
  })
})

describe("dismissal rules (the user's spec: voice OR act)", () => {
  test("a dismissal phrase ends the lesson and retracts the guide", () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me X", true)
    h.mgr.notePointFromTool({ label: "X" })
    h.mgr.onUserUtterance("c1", "okay stop, that's enough")
    expect(h.mgr.active).toBeNull()
    expect(h.retracted()).toBe(1)
  })

  test("mid-lesson speech that is NOT a dismissal keeps the lesson and the highlight", () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me X", true)
    h.mgr.notePointFromTool({ label: "X" })
    h.mgr.onUserUtterance("c1", "I'm in Appearance now, what?")
    expect(h.mgr.active).not.toBeNull()
    expect(h.retracted()).toBe(0)
  })

  test("ANY speech dismisses a standalone highlight", () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "show me where the Trash is", false)
    h.mgr.notePointFromTool({ label: "Trash", app: "Dock" })
    h.mgr.onUserUtterance("c1", "what's the weather tomorrow?")
    expect(h.retracted()).toBe(1)
    expect(h.mgr.lastPointed()).toBeNull()
  })

  test("a new conversation ends a lesson from the old one", () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me X", true)
    h.mgr.notePointFromTool({ label: "X" })
    h.mgr.onUserUtterance("c2", "hello")
    expect(h.mgr.active).toBeNull()
    expect(h.retracted()).toBe(1)
  })
})

describe("auto-continue (between-turns screen watcher)", () => {
  test("turn end arms a watcher; screen change injects a continuation", async () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance", app: "System Settings" })
    h.mgr.afterTurn("c1")
    expect(h.watches.length).toBe(1)
    expect(h.watches[0]!.app).toBe("System Settings")
    h.watches[0]!.d.resolve(true)
    await flush()
    expect(h.continued).toEqual(["c1"])
    expect(h.mgr.active?.continuations).toBe(1)
  })

  test("a watcher that resolves AFTER a real utterance is stale — no continuation", async () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance" })
    h.mgr.afterTurn("c1")
    h.mgr.onUserUtterance("c1", "what's next?")        // real turn supersedes the watcher
    h.watches[0]!.d.resolve(true)
    await flush()
    expect(h.continued).toEqual([])
  })

  test("a timed-out watcher stays quiet (no continuation, no retraction)", async () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance" })
    h.mgr.afterTurn("c1")
    h.watches[0]!.d.resolve(false)
    await flush()
    expect(h.continued).toEqual([])
    expect(h.mgr.active).not.toBeNull()
    expect(h.retracted()).toBe(0)
  })

  test("ending the lesson invalidates a pending watcher", async () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance" })
    h.mgr.afterTurn("c1")
    h.mgr.end("goal complete")
    h.watches[0]!.d.resolve(true)
    await flush()
    expect(h.continued).toEqual([])
  })
})

describe("standalone act-dismissal", () => {
  test("turn end arms a change watch; the user acting retracts quietly", async () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "show me where the Trash is", false)
    h.mgr.notePointFromTool({ label: "Trash", app: "Dock" })
    h.mgr.afterTurn("c1")
    expect(h.watches.length).toBe(1)
    h.watches[0]!.d.resolve(true)
    await flush()
    expect(h.retracted()).toBe(1)
    expect(h.continued).toEqual([])     // standalone never auto-continues
  })
})

describe("planner context", () => {
  test("lesson block renders goal + still-highlighted step and demands resume", () => {
    const { mgr } = harness()
    mgr.setTurnContext("c1", "teach me how to switch to dark mode", true)
    mgr.notePointFromTool({ label: "Appearance", app: "System Settings" }, "click Appearance in the sidebar")
    const block = mgr.contextBlockFor("c1")
    expect(block).toContain("## Active walkthrough")
    expect(block).toContain("dark mode")
    expect(block).toContain('"Appearance"')
    expect(block).toContain("STILL highlighted")
    expect(block).toContain("end_lesson")
  })

  test("standalone hint renders the re-highlight instruction; other cids get nothing", () => {
    const { mgr } = harness()
    mgr.setTurnContext("c1", "show me where the Trash is", false)
    mgr.notePointFromTool({ label: "Trash", find: "Trash", app: "Dock" })
    expect(mgr.contextBlockFor("c1")).toContain("guide_user")
    expect(mgr.contextBlockFor("c1")).toContain("Recent on-screen highlight")
    // lesson blocks are conversation-scoped; standalone hints are global by design
  })

  test("no session → empty context", () => {
    const { mgr } = harness()
    expect(mgr.contextBlockFor("c1")).toBe("")
  })
})

describe("premature end_lesson refusal", () => {
  test("the model cannot end a lesson before the user completes a single step", () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance" })
    expect(h.mgr.endRequestFromModel("goal complete")).toBe(false)   // refused
    expect(h.mgr.active).not.toBeNull()
    expect(h.retracted()).toBe(0)
  })

  test("after a confirmed step, the model may end the lesson", () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance" })
    h.mgr.noteStepDone()                                             // wait_for_screen confirmed
    expect(h.mgr.endRequestFromModel("goal complete")).toBe(true)
    expect(h.mgr.active).toBeNull()
    expect(h.retracted()).toBe(1)
  })

  test("auto-continue counts as a completed step (end allowed afterwards)", async () => {
    const h = harness()
    h.mgr.setTurnContext("c1", "teach me dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance" })
    h.mgr.afterTurn("c1")
    h.watches[0]!.d.resolve(true)
    await flush()
    expect(h.mgr.endRequestFromModel("goal complete")).toBe(true)
  })

  test("no lesson → end request is a harmless no-op success", () => {
    const h = harness()
    expect(h.mgr.endRequestFromModel("nothing")).toBe(true)
  })
})

describe("regexes + sentinel", () => {
  test("dismissals match; lesson talk doesn't", () => {
    for (const yes of ["okay stop", "never mind", "that's all thanks", "I'm done", "forget it"]) {
      expect(LESSON_DISMISS_RE.test(yes)).toBe(true)
    }
    for (const no of ["I'm in Appearance now, what?", "highlight it again", "what's next", "which one is light mode"]) {
      expect(LESSON_DISMISS_RE.test(no)).toBe(false)
    }
  })

  test("the continuation text is recall-quarantine bait by design", () => {
    // WALKTHROUGH_ECHO_RE quarantines "what's next" fragments from memory recall —
    // the synthetic turn must keep matching it so lessons never poison recall.
    expect(LESSON_CONTINUE_TEXT.toLowerCase()).toContain("what's next")
    expect(LESSON_CONTINUE_SENTINEL.startsWith("[[")).toBe(true)
  })
})

describe("stuck-overlay fix: a no-guidance turn retracts the stale cue (afterTurn)", () => {
  function liveLesson() {
    const h = harness()
    h.mgr.setTurnContext("c1", "walk me through dark mode", true)
    h.mgr.notePointFromTool({ label: "Appearance", app: "System Settings" }, "click Appearance")
    h.mgr.afterTurn("c1")   // first step pointed → arms auto-continue, no retract
    return h
  }
  test("a lesson turn that produced NO guidance retracts the lingering cue (lesson stays armed)", () => {
    const h = liveLesson()
    const before = h.retracted()
    // next turn: user asks something unrelated → conductor answers, NO guide point
    h.mgr.setTurnContext("c1", "what's the weather today?", false)
    h.mgr.afterTurn("c1")
    expect(h.retracted()).toBe(before + 1)   // stuck arrow/highlight cleared, orb re-forms
    expect(h.mgr.active).not.toBeNull()       // lesson stays armed for a later resume
  })
  test("a lesson turn that DID point does NOT retract (cue is fresh)", () => {
    const h = liveLesson()
    h.mgr.setTurnContext("c1", "continue", false)
    h.mgr.notePointFromTool({ label: "Dark", app: "System Settings" })
    const before = h.retracted()
    h.mgr.afterTurn("c1")
    expect(h.retracted()).toBe(before)
  })
  test("a scroll-arrow turn (noteGuideShown) does NOT retract", () => {
    const h = liveLesson()
    h.mgr.setTurnContext("c1", "continue", false)
    h.mgr.noteGuideShown()   // showed a scroll arrow (not a point) — still 'guided'
    const before = h.retracted()
    h.mgr.afterTurn("c1")
    expect(h.retracted()).toBe(before)
  })
})

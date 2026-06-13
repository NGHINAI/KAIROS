// guideAct.test.ts — ACT MODE (computer use): click_element / type_text tools and
// the phantom screen-action verifier gate. The contract under test:
//   • element-index/label addressing only, confirm gate on irreversible labels,
//   • self-heal when the app isn't running, verify-after-act instruction,
//   • a final claiming an on-screen act with no successful screen tool is flagged.
import { describe, expect, test } from "bun:test"
import { buildGuideTools, DANGEROUS_LABEL_RE } from "./guideTools"
import { buildDestructiveVerifier } from "./loop/verifier"

function tools(overrides: Partial<Record<string, any>> = {}) {
  const calls: any[] = []
  const built = buildGuideTools({
    bridge: {
      request: async () => ({ found: true, label: "X" }),
      requestAct: async (req: any) => {
        calls.push(req)
        return overrides.act ? overrides.act(req) : { found: true, label: req.find ?? `el${req.element}` }
      },
      requestScreen: overrides.requestScreen,
    } as any,
    openApp: overrides.openApp,
    lesson: overrides.lesson,
  })
  return { built, calls, get: (n: string) => built.find((t) => t.name === n)! }
}

describe("click_element", () => {
  test("success → grounded 'Clicked' + verify instruction; confirm guard rides along", async () => {
    const { get, calls } = tools()
    const out = await get("click_element").execute({ find: "Dark", app: "System Settings" })
    expect(out).toContain('Clicked "Dark"')
    expect(out).toContain("read_screen to verify")
    expect(calls[0].action).toBe("press")
    expect(calls[0].confirm).toBe(false)
    expect(calls[0].confirmGuard).toBe(DANGEROUS_LABEL_RE.source)
  })

  test("needs_confirm → STOP + ask-the-user instruction, no second press", async () => {
    const { get } = tools({ act: () => ({ found: false, label: "Empty Trash", reason: "needs_confirm" }) })
    const out = await get("click_element").execute({ find: "Empty Trash" })
    expect(out).toContain("STOP")
    expect(out).toContain("Empty Trash")
    expect(out).toContain("confirm: true")
  })

  test("the danger pattern catches the labels that matter", () => {
    for (const label of ["Empty Trash", "Delete", "Send", "Buy Now", "Restart", "Sign Out", "Pay"]) {
      expect(DANGEROUS_LABEL_RE.test(label)).toBe(true)
    }
    for (const label of ["Appearance", "Dark", "General", "Wallpaper", "Open"]) {
      expect(DANGEROUS_LABEL_RE.test(label)).toBe(false)
    }
  })

  test("app not running → opens it itself and retries once", async () => {
    let first = true
    let opened = 0
    const { get, calls } = tools({
      act: () => {
        if (first) { first = false; return { found: false, reason: 'no running app called "System Settings"' } }
        return { found: true, label: "Appearance" }
      },
      openApp: async () => { opened++; return { ok: true } },
    })
    const out = await get("click_element").execute({ find: "Appearance", app: "System Settings" })
    expect(opened).toBe(1)
    expect(calls.length).toBe(2)
    expect(out).toContain('Clicked "Appearance"')
  })

  test("a successful click counts as a completed lesson step", async () => {
    let steps = 0
    const { get } = tools({ lesson: { notePoint: () => {}, noteStepDone: () => { steps++ }, endLesson: () => true } })
    await get("click_element").execute({ find: "Dark" })
    expect(steps).toBe(1)
  })

  test("no element/find → demands addressing; never a blind click", async () => {
    const { get, calls } = tools()
    const out = await get("click_element").execute({})
    expect(out).toContain("element NUMBER")
    expect(calls.length).toBe(0)
  })
})

describe("type_text", () => {
  test("success → grounded 'Typed into' + verify instruction; submit noted", async () => {
    const { get, calls } = tools()
    const out = await get("type_text").execute({ text: "hello", find: "Search", submit: true })
    expect(out).toContain('Typed into "Search"')
    expect(out).toContain("pressed Return")
    expect(calls[0].action).toBe("set_value")
    expect(calls[0].text).toBe("hello")
    expect(calls[0].submit).toBe(true)
  })
})

describe("read_screen self-heal", () => {
  test("app not running → opens it itself and reads again", async () => {
    let first = true
    let opened = 0
    const { get } = tools({
      requestScreen: async () => {
        if (first) { first = false; return { found: false, reason: 'no running app called "System Settings"' } }
        return { found: true, summary: "App: System Settings\nItems: 1 Appearance" }
      },
      openApp: async () => { opened++; return { ok: true } },
    })
    const out = await get("read_screen").execute({ app: "System Settings" })
    expect(opened).toBe(1)
    expect(out).toContain("CURRENT SCREEN")
  })
})

describe("do-mode verifier gate", () => {
  const verifier = buildDestructiveVerifier({ llm: { complete: async () => ({ text: '{"ok":true}' }) } })

  test("a DO ask answered by pointing + 'please click' → flagged toward click_element", async () => {
    const r = await verifier.verify({
      utterance: "Switch my Mac to light mode.",
      finalText: "I'm highlighting General now. Please click on that to proceed.",
      toolCalls: [
        { name: "read_screen", result: "CURRENT SCREEN …" },
        { name: "guide_user", result: 'Pointing at "Appearance" now — the user can see the highlight…' },
      ],
    })
    expect(r.ok).toBe(false)
    expect(r.concern).toContain("click_element")
  })

  test("a DO ask actually clicked → passes", async () => {
    const r = await verifier.verify({
      utterance: "Switch my Mac to light mode.",
      finalText: "Done — your Mac is in light mode now.",
      toolCalls: [
        { name: "read_screen", result: "CURRENT SCREEN …" },
        { name: "click_element", result: 'Clicked "Light". NOW call read_screen to verify…' },
        { name: "read_screen", result: "CURRENT SCREEN …" },
      ],
    })
    expect(r.ok).toBe(true)
  })

  test("a confirm-pause question is a legitimate stop, not outsourcing", async () => {
    const r = await verifier.verify({
      utterance: "Click send on that email.",
      finalText: "Should I click Send?",
      toolCalls: [{ name: "click_element", result: 'STOP — "Send" looks irreversible (it\'s highlighted on screen now)…' }],
    })
    expect(r.ok).toBe(true)
  })

  test("teaching asks are exempt — pointing is the point", async () => {
    const r = await verifier.verify({
      utterance: "Can you teach me how to switch to light mode?",
      finalText: "I'm highlighting Appearance — click that and I'll take you from there.",
      toolCalls: [
        { name: "read_screen", result: "CURRENT SCREEN …" },
        { name: "guide_user", result: 'Pointing at "Appearance" now…' },
        { name: "wait_for_screen", result: '"Light" hasn\'t appeared yet…' },
      ],
    })
    expect(r.ok).toBe(true)
  })
})

describe("phantom screen-action verifier gate", () => {
  const verifier = buildDestructiveVerifier({ llm: { complete: async () => ({ text: '{"ok":true}' }) } })

  test("claiming a highlight with NO screen tool → flagged, even on a question-final", async () => {
    const r = await verifier.verify({
      utterance: "Okay, system settings is open.",
      finalText: "I'm highlighting the Appearance section in the sidebar. Can you see it?",
      toolCalls: [{ name: "read_screen", result: "CURRENT SCREEN …" }],
    })
    expect(r.ok).toBe(false)
    expect(r.retryable).toBe(true)
    expect(r.concern).toContain("no screen tool succeeded")
  })

  test("the same claim WITH a successful point passes", async () => {
    const r = await verifier.verify({
      utterance: "Okay, system settings is open.",
      finalText: "I'm highlighting the Appearance section — click that.",
      toolCalls: [
        { name: "read_screen", result: "CURRENT SCREEN …" },
        { name: "guide_user", result: 'Pointing at "Appearance" now — the user can see the highlight…' },
        { name: "wait_for_screen", result: '"Light" is on screen — the user completed the step.' },
      ],
    })
    expect(r.ok).toBe(true)
  })

  test("'I clicked Dark' grounded by a successful click_element passes", async () => {
    const r = await verifier.verify({
      utterance: "switch my mac to dark mode",
      finalText: "Done — I clicked Dark and your Mac is in dark mode now.",
      toolCalls: [
        { name: "read_screen", result: "CURRENT SCREEN …" },
        { name: "click_element", result: 'Clicked "Dark". NOW call read_screen to verify…' },
        { name: "read_screen", result: "CURRENT SCREEN …" },
      ],
    })
    expect(r.ok).toBe(true)
  })

  test("a FAILED guide_user does not license the claim", async () => {
    const r = await verifier.verify({
      utterance: "show me",
      finalText: "I'm pointing at it now.",
      toolCalls: [{ name: "guide_user", result: "Couldn't find X on screen…" }],
    })
    expect(r.ok).toBe(false)
  })
})

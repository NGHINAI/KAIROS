// src/daemon/agents/guideBridge.test.ts
import { test, expect } from "bun:test"
import { GuideBridge } from "./guideBridge"
import { buildGuideTools } from "./guideTools"

function bridgeWith(timeoutMs = 200) {
  const sent: any[] = []
  const bridge = new GuideBridge({ broadcast: (e) => sent.push(e), timeoutMs })
  return { bridge, sent }
}

test("request broadcasts guide_request and resolves with the HUD's answer", async () => {
  const { bridge, sent } = bridgeWith()
  const p = bridge.request({ find: "the Export button", app: "Numbers" })
  expect(sent.length).toBe(1)
  expect(sent[0].event).toBe("guide_request")
  expect(sent[0].find).toBe("the Export button")
  expect(sent[0].app).toBe("Numbers")
  bridge.resolve(sent[0].id, { found: true, label: "Export…" })
  const r = await p
  expect(r).toEqual({ found: true, label: "Export…", reason: undefined })
  expect(bridge.isActive).toBe(true)
})

test("no HUD answer → resolves null after the timeout (tool degrades to verbal guidance)", async () => {
  const { bridge } = bridgeWith(50)
  const r = await bridge.request({ find: "anything" })
  expect(r).toBeNull()
})

test("duplicate/unknown results are ignored safely", async () => {
  const { bridge, sent } = bridgeWith()
  const p = bridge.request({ find: "x" })
  bridge.resolve("nonsense-id", { found: true })
  bridge.resolve(sent[0].id, { found: false, reason: "not visible" })
  bridge.resolve(sent[0].id, { found: true })          // late duplicate — ignored
  const r = await p
  expect(r!.found).toBe(false)
  expect(r!.reason).toBe("not visible")
})

test("endIfActive broadcasts guide_end once and flushes outstanding requests", async () => {
  const { bridge, sent } = bridgeWith(5_000)
  const p = bridge.request({ find: "slow thing" })
  bridge.endIfActive()
  expect(await p).toBeNull()                            // outstanding request flushed
  expect(sent.some((e) => e.event === "guide_end")).toBe(true)
  const ends = sent.filter((e) => e.event === "guide_end").length
  bridge.endIfActive()                                  // idempotent when inactive
  expect(sent.filter((e) => e.event === "guide_end").length).toBe(ends)
  expect(bridge.isActive).toBe(false)
})

// ── guide_user tool ──

test("guide_user reports success with the resolved label and prompts the next step", async () => {
  const [tool] = buildGuideTools({ bridge: { request: async () => ({ found: true, label: "Export…" }) } })
  expect(tool!.name).toBe("guide_user")
  const out = await tool!.execute({ find: "the Export button" })
  expect(out).toContain('Pointing at "Export…"')
  expect(out).toContain("next step")
})

test("guide_user teaches recovery when the element isn't found", async () => {
  const [tool] = buildGuideTools({ bridge: { request: async () => ({ found: false, reason: "no match in frontmost window" }) } })
  const out = await tool!.execute({ find: "the Zorp button" })
  expect(out).toContain("Couldn't find")
  expect(out).toContain("no match in frontmost window")
  expect(out).toContain("verbally")
})

test("guide_user degrades to verbal guidance when no HUD is connected", async () => {
  const [tool] = buildGuideTools({ bridge: { request: async () => null } })
  const out = await tool!.execute({ find: "anything" })
  expect(out).toContain("VERBALLY")
})

test("guide_user rejects an empty target", async () => {
  let called = false
  const [tool] = buildGuideTools({ bridge: { request: async () => { called = true; return null } } })
  const out = await tool!.execute({ find: "  " })
  expect(called).toBe(false)
  expect(out).toContain("WHAT to point at")
})

// ── open_app (the self-healing step: never ask the user to open an app) ──

test("guide_user SELF-HEALS: opens the app itself and retries when it isn't running", async () => {
  let calls = 0
  const opened: string[] = []
  const [tool] = buildGuideTools({
    bridge: {
      request: async () => {
        calls++
        return calls === 1
          ? { found: false, reason: 'no running app called "System Settings"' }
          : { found: true, label: "Accessibility" }
      },
    },
    openApp: async (name) => { opened.push(name); return { ok: true } },
  })
  const out = await tool!.execute({ find: "Accessibility", app: "System Settings" })
  expect(opened).toEqual(["System Settings"])
  expect(calls).toBe(2)
  expect(out).toContain('Pointing at "Accessibility"')
}, 10_000)

test("self-heal still teaches when the retry ALSO misses", async () => {
  const [tool] = buildGuideTools({
    bridge: { request: async () => ({ found: false, reason: 'no running app called "Settingz"' }) },
    openApp: async () => ({ ok: false, error: "not found" }),
  })
  const out = await tool!.execute({ find: "Anything", app: "Settingz" })
  expect(out).toContain("Couldn't find")
})

test("open_app launches by name and tells the model to retry the guide", async () => {
  const opened: string[] = []
  const tools = buildGuideTools({
    bridge: { request: async () => null },
    openApp: async (name) => { opened.push(name); return { ok: true } },
  })
  const openApp = tools.find((t) => t.name === "open_app")!
  const out = await openApp.execute({ name: "System Settings" })
  expect(opened).toEqual(["System Settings"])
  expect(out).toContain("guide_user")
})

test("open_app surfaces launch failures with the app name", async () => {
  const tools = buildGuideTools({
    bridge: { request: async () => null },
    openApp: async () => ({ ok: false, error: "Unable to find application" }),
  })
  const openApp = tools.find((t) => t.name === "open_app")!
  const out = await openApp.execute({ name: "Settingz" })
  expect(out).toContain('Couldn\'t open "Settingz"')
  expect(out).toContain("Unable to find application")
})

test("open_app is absent when no launcher is wired (HUD-less environments)", () => {
  const tools = buildGuideTools({ bridge: { request: async () => null, click: async () => null } })
  expect(tools.map((t) => t.name).sort()).toEqual(["click_element", "guide_user"])
})

// ── click_element (actuation) ──

test("click_element presses the resolved element and confirms", async () => {
  const tools = buildGuideTools({ bridge: { request: async () => null, click: async () => ({ found: true, label: "Subscribe Now" }) } })
  const click = tools.find((t) => t.name === "click_element")!
  const out = await click.execute({ find: "Subscribe", app: "Safari" })
  expect(out).toContain('Clicked "Subscribe Now"')
})

test("click_element self-heals: opens the app then retries the click", async () => {
  let n = 0
  const opened: string[] = []
  const tools = buildGuideTools({
    bridge: {
      request: async () => null,
      click: async () => { n++; return n === 1 ? { found: false, reason: 'no running app called "Music"' } : { found: true, label: "Play" } },
    },
    openApp: async (name) => { opened.push(name); return { ok: true } },
  })
  const click = tools.find((t) => t.name === "click_element")!
  const out = await click.execute({ find: "Play", app: "Music" })
  expect(opened).toEqual(["Music"])
  expect(out).toContain('Clicked "Play"')
}, 10_000)

test("click_element teaches when it can't activate the element", async () => {
  const tools = buildGuideTools({ bridge: { request: async () => null, click: async () => ({ found: false, reason: "the app didn't accept a press" }) } })
  const click = tools.find((t) => t.name === "click_element")!
  const out = await click.execute({ find: "Ghost", app: "Finder" })
  expect(out).toContain("Couldn't click")
  expect(out).toContain("didn't accept a press")
})

test("click_element degrades to verbal when no HUD is connected", async () => {
  const tools = buildGuideTools({ bridge: { request: async () => null, click: async () => null } })
  const click = tools.find((t) => t.name === "click_element")!
  const out = await click.execute({ find: "anything" })
  expect(out).toContain("isn't available")
})

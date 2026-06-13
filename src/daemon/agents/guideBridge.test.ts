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
  expect(out).toContain("say one short line")     // voice-sync contract: name what's highlighted
  expect(out).toContain("wait_for_screen")        // the loop: watch for the click's effect
})

test("guide_user teaches recovery when the element isn't found", async () => {
  const [tool] = buildGuideTools({ bridge: { request: async () => ({ found: false, reason: "no match in frontmost window" }) } })
  const out = await tool!.execute({ find: "the Zorp button" })
  expect(out).toContain("Couldn't find")
  expect(out).toContain("no match in frontmost window")
  expect(out).toContain("read_screen")
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

// ── wait_for_screen (the walkthrough heartbeat: auto-advance without "done") ──

test("requestWatch round-trips with its own extended timeout", async () => {
  const { bridge, sent } = bridgeWith(50)              // bridge default timeout tiny…
  const p = bridge.requestWatch({ find: "Dark", app: "System Settings", timeoutMs: 400 })
  expect(sent[0].event).toBe("watch_request")
  expect(sent[0].timeoutMs).toBe(400)
  await new Promise((r) => setTimeout(r, 150))          // …but the watch outlives it
  bridge.resolve(sent[0].id, { found: true, label: "Dark" })
  const r = await p
  expect(r!.found).toBe(true)
})

test("wait_for_screen tells the model to advance IMMEDIATELY when the element appears", async () => {
  const tools = buildGuideTools({
    bridge: { request: async () => null, requestWatch: async () => {
      await new Promise((r) => setTimeout(r, 2100))   // a REAL wait (instant hits warn instead)
      return { found: true, label: "Dark" }
    } },
  })
  const wait = tools.find((t) => t.name === "wait_for_screen")!
  const out = await wait.execute({ until: "Dark" })
  expect(out).toContain("completed the step")
  expect(out).toContain("IMMEDIATELY")
}, 10_000)

test("a wait timeout routes to read_screen recovery, not nagging", async () => {
  const tools = buildGuideTools({
    bridge: { request: async () => null, requestWatch: async () => ({ found: false, reason: "not seen within the wait window" }) },
  })
  const wait = tools.find((t) => t.name === "wait_for_screen")!
  const out = await wait.execute({ until: "Dark", timeout_seconds: 5 })
  expect(out).toContain("hasn't appeared")
  expect(out).toContain("read_screen")
})

test("wait_for_screen clamps the timeout and degrades without a HUD", async () => {
  let captured: any = null
  const tools = buildGuideTools({
    bridge: { request: async () => null, requestWatch: async (req) => { captured = req; return { found: true } } },
  })
  const wait = tools.find((t) => t.name === "wait_for_screen")!
  await wait.execute({ until: "X", timeout_seconds: 9999 })
  expect(captured.timeoutMs).toBe(120_000)
  const bare = buildGuideTools({ bridge: { request: async () => null } })
  const out = await bare.find((t) => t.name === "wait_for_screen")!.execute({ until: "X" })
  expect(out).toContain("say 'done'")
})

test("an INSTANT watch hit warns the model it watched for the wrong thing", async () => {
  const tools = buildGuideTools({
    bridge: { request: async () => null, requestWatch: async () => ({ found: true, label: "Appearance" }) },
  })
  const wait = tools.find((t) => t.name === "wait_for_screen")!
  const out = await wait.execute({ until: "Appearance" })   // resolves in ~0ms
  expect(out).toContain("ALREADY visible")
  // toggle-step escape: an already-visible target may BE the final step
  expect(out).toContain("END your turn")
  expect(out).toContain("point the CURRENT step first")
})

test("guide_user self-heals a CLOSED WINDOW too (app running, no windows)", async () => {
  let calls = 0
  const opened: string[] = []
  const [tool] = buildGuideTools({
    bridge: {
      request: async () => {
        calls++
        return calls === 1
          ? { found: false, reason: "System Settings is running but its window is closed — call open_app to bring it forward, then point again" }
          : { found: true, label: "Wallpaper" }
      },
    },
    openApp: async (name) => { opened.push(name); return { ok: true } },
  })
  const out = await tool!.execute({ find: "Wallpaper", app: "System Settings" })
  expect(opened).toEqual(["System Settings"])
  expect(out).toContain('Pointing at "Wallpaper"')
}, 10_000)

// ── read_screen (dynamic guidance: look → point → look) ──

test("requestScreen round-trips a screen inventory through the bridge", async () => {
  const { bridge, sent } = bridgeWith()
  const p = bridge.requestScreen("System Settings")
  expect(sent[0].event).toBe("screen_request")
  expect(sent[0].app).toBe("System Settings")
  bridge.resolve(sent[0].id, { found: true, summary: "App: System Settings\nItems: General · Accessibility" })
  const r = await p
  expect(r!.summary).toContain("Accessibility")
})

test("read_screen returns the inventory framed as planning-only context", async () => {
  const tools = buildGuideTools({
    bridge: {
      request: async () => null,
      requestScreen: async () => ({ found: true, summary: "App: System Settings\nItems: General · Accessibility · Appearance" }),
    },
  })
  const readScreen = tools.find((t) => t.name === "read_screen")!
  const out = await readScreen.execute({ app: "System Settings" })
  expect(out).toContain("planning ONLY")
  expect(out).toContain("Accessibility")
})

test("read_screen degrades gracefully without a HUD or on failure", async () => {
  const tools = buildGuideTools({
    bridge: { request: async () => null, requestScreen: async () => null },
  })
  const readScreen = tools.find((t) => t.name === "read_screen")!
  expect(await readScreen.execute({})).toContain("Guide verbally")
  const tools2 = buildGuideTools({
    bridge: { request: async () => null, requestScreen: async () => ({ found: false, reason: "no Accessibility permission" }) },
  })
  const out2 = await tools2.find((t) => t.name === "read_screen")!.execute({})
  expect(out2).toContain("no Accessibility permission")
})

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
  const tools = buildGuideTools({ bridge: { request: async () => null } })
  expect(tools.map((t) => t.name)).toEqual(["guide_user", "read_screen", "wait_for_screen"])
})

import { describe, expect, test } from "bun:test"
import { isNotConnectedResult, toolkitFromToolName, wrapComposioSelfHeal } from "./composioSelfHeal"

describe("composioSelfHeal", () => {
  test("isNotConnectedResult detects the not-connected family, ignores other errors/success", () => {
    expect(isNotConnectedResult({ successful: false, error: "GMAIL is not connected" })).toBe(true)
    expect(isNotConnectedResult({ successful: false, error: "No connected account for gmail" })).toBe(true)
    expect(isNotConnectedResult({ successful: false, error: "please connect the toolkit first" })).toBe(true)
    expect(isNotConnectedResult({ successful: true, data: {} })).toBe(false)            // success
    expect(isNotConnectedResult({ successful: false, error: "rate limited" })).toBe(false) // other error
    expect(isNotConnectedResult("string")).toBe(false)
  })

  test("toolkitFromToolName extracts the toolkit slug", () => {
    expect(toolkitFromToolName("GMAIL_SEND_EMAIL")).toBe("gmail")
    expect(toolkitFromToolName("GOOGLECALENDAR_CREATE_EVENT")).toBe("googlecalendar")
  })

  test("passes a successful result straight through (no heal)", async () => {
    let healCalls = 0
    const wrapped = wrapComposioSelfHeal({ execute: async () => ({ successful: true, data: 42 }), getSelfHeal: () => { healCalls++; return undefined } })
    expect(await wrapped("GMAIL_SEND", {})).toEqual({ successful: true, data: 42 })
    expect(healCalls).toBe(0)   // getSelfHeal not even consulted on success
  })

  test("NOT_CONNECTED → connects the right toolkit + retries → returns the healed result", async () => {
    let calls = 0
    const execute = async () => (++calls === 1 ? { successful: false, error: "not connected" } : { successful: true, data: "sent" })
    let healedToolkit = ""
    const wrapped = wrapComposioSelfHeal({
      execute,
      getSelfHeal: () => ({ connectAndRetry: async (toolkit, retry) => { healedToolkit = toolkit; const toolResult = await retry(); return { status: "connected", toolResult } } }),
    })
    const res = await wrapped("GMAIL_SEND_EMAIL", {})
    expect(healedToolkit).toBe("gmail")
    expect(res).toEqual({ successful: true, data: "sent" })
  })

  test("heal timeout/failure → returns the ORIGINAL not-connected result (model can tell the user)", async () => {
    const wrapped = wrapComposioSelfHeal({
      execute: async () => ({ successful: false, error: "not connected" }),
      getSelfHeal: () => ({ connectAndRetry: async () => ({ status: "timeout" }) }),
    })
    expect(await wrapped("SLACK_SEND", {})).toEqual({ successful: false, error: "not connected" })
  })

  test("no self-heal available → returns the original result (no crash)", async () => {
    const wrapped = wrapComposioSelfHeal({ execute: async () => ({ successful: false, error: "not connected" }), getSelfHeal: () => undefined })
    expect(await wrapped("X_Y", {})).toEqual({ successful: false, error: "not connected" })
  })
})

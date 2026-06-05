// src/daemon/agents/intentToolBridge.test.ts
import { test, expect } from "bun:test"
import { intentsAsTools } from "./intentToolBridge"

function entry(id: string, description: string, argSchema: Record<string, string> = {}, tier = "YELLOW") {
  return {
    id,
    tier,
    intent: { id, description, tier, argSchema },
    handler: async () => ({ status: "success", details: "ok" }),
  } as any
}

test("intentsAsTools converts registry intents into ToolDef[] with a JSON-schema parameters block", () => {
  const registry = {
    list: () => [entry("connect-service", "Connect an external service via OAuth", { service: "string" })],
  }
  const tools = intentsAsTools({ registry: registry as any, dispatch: async () => ({ status: "success", details: "" }) })
  expect(tools.length).toBe(1)
  expect(tools[0].name).toBe("connect-service")
  expect(tools[0].description).toContain("Connect an external service")
  expect(tools[0].parameters).toEqual({ type: "object", properties: { service: { type: "string" } }, required: [] })
})

test("intentsAsTools sanitizes MCP qualified ids (::) into valid tool names but dispatches the ORIGINAL id", async () => {
  const registry = {
    list: () => [entry("macos-reminders::add_reminder", "[macos-reminders] Add a reminder", { title: "string" })],
  }
  const calls: Array<{ id: string; args: any }> = []
  const dispatch = async (id: string, args: any) => {
    calls.push({ id, args })
    return { status: "success", details: "added" }
  }
  const tools = intentsAsTools({ registry: registry as any, dispatch })
  expect(tools[0].name).toBe("macos-reminders__add_reminder")
  const res = await tools[0].execute({ title: "Buy milk" })
  expect(calls[0].id).toBe("macos-reminders::add_reminder")
  expect(calls[0].args).toEqual({ title: "Buy milk" })
  expect(res).toEqual({ status: "success", details: "added" })
})

test("intentsAsTools applies the optional filter to exclude internal intents", () => {
  const registry = {
    list: () => [entry("connect-service", "connect"), entry("log", "internal log")],
  }
  const tools = intentsAsTools({
    registry: registry as any,
    dispatch: async () => ({ status: "success", details: "" }),
    filter: (e: any) => e.id !== "log",
  })
  expect(tools.map((t) => t.name)).toEqual(["connect-service"])
})

// src/daemon/agents/selfHealConnect.test.ts
import { test, expect } from "bun:test"
import { SelfHealConnect } from "./selfHealConnect"

test("SelfHealConnect.connectAndRetry opens browser, polls, returns success", async () => {
  let opened: string | undefined
  let pollCount = 0
  const result = await new SelfHealConnect({
    composio: {
      initiateConnection: async () => ({ connection_id: "c1", redirect_url: "https://oauth.example/auth" }),
      getConnection: async () => {
        pollCount++
        return { status: pollCount > 2 ? "ACTIVE" : "PENDING" }
      },
    } as any,
    openBrowser: async (url: string) => { opened = url },
    pollIntervalMs: 5,
    maxWaitMs: 1000,
  }).connectAndRetry("gmail", async () => "tool-result")
  expect(opened).toBe("https://oauth.example/auth")
  expect(result.status).toBe("connected")
  if (result.status === "connected") expect(result.toolResult).toBe("tool-result")
})

test("SelfHealConnect returns timeout if connection never goes ACTIVE", async () => {
  const result = await new SelfHealConnect({
    composio: {
      initiateConnection: async () => ({ connection_id: "c1", redirect_url: "https://oauth.example/auth" }),
      getConnection: async () => ({ status: "PENDING" }),
    } as any,
    openBrowser: async () => {},
    pollIntervalMs: 5,
    maxWaitMs: 50,
  }).connectAndRetry("gmail", async () => "tool-result")
  expect(result.status).toBe("timeout")
})

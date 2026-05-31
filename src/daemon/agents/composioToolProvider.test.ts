// src/daemon/agents/composioToolProvider.test.ts
import { test, expect } from "bun:test"
import { buildComposioSearchTool, ComposioToolCache } from "./composioToolProvider"

test("composio_search_tools returns up to N tool defs matching query", async () => {
  const fakeComposio = {
    searchTools: async (q: string, limit: number) => [
      { slug: "gmail_search_messages", description: "Search Gmail by query" },
      { slug: "gmail_send_message", description: "Send a Gmail message" },
    ].slice(0, limit),
  }
  const tool = buildComposioSearchTool({ composio: fakeComposio as any, cache: new ComposioToolCache() })
  const result = await tool.execute({ query: "gmail", limit: 5 })
  expect(result.tools.length).toBe(2)
  expect(result.tools[0].slug).toContain("gmail")
})

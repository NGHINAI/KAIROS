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

// Regression: the index.ts searchTools closure used getRawComposioTools({ limit })
// with NO filter, which throws ValidationError on @composio/core@0.10.0 → silently
// returned []. This models the FIXED behavior: searchTools forwards the query (the
// real closure passes it as `search`) and surfaces the hits instead of swallowing them.
test("composio_search_tools forwards the query and surfaces hits (no silent empty)", async () => {
  let receivedQuery = ""
  const fakeComposio = {
    // Mirrors the fixed closure: a query-driven search that returns real results.
    searchTools: async (q: string, _limit: number) => {
      receivedQuery = q
      return [{ slug: "GOOGLECALENDAR_CREATE_EVENT", description: "Create a calendar event", toolkit: "googlecalendar" }]
    },
  }
  const tool = buildComposioSearchTool({ composio: fakeComposio as any, cache: new ComposioToolCache() })
  const result = await tool.execute({ query: "calendar" })
  expect(receivedQuery).toBe("calendar")
  expect(result.tools.length).toBe(1)
  expect(result.tools[0].slug).toBe("GOOGLECALENDAR_CREATE_EVENT")
})

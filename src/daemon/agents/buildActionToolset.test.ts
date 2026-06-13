// buildActionToolset.test.ts — the single source of truth for the agent toolset
// (one assembly, two consumers: the in-house loop + the Codex MCP server). Guards
// that the extraction from index.ts preserved the tools + graceful degradation.
import { describe, expect, test } from "bun:test"
import { buildActionToolset, type ActionToolDeps } from "./buildActionToolset"

// Minimal fakes — the builders construct ToolDefs eagerly; deps are used at
// execute time, so simple stand-ins are enough to assert the toolset shape.
function fullDeps(over: Partial<ActionToolDeps> = {}): ActionToolDeps {
  return {
    toolRetriever: {
      getByNames: (_names: string[]) => [
        { name: "GMAIL_SEND_EMAIL", description: "send mail", parameters: { type: "object", properties: {} } },
      ],
      search: async () => [],
    },
    composioExecute: async (_n: string, _a: any) => ({ ok: true }),
    toolUsage: { topNames: (_n: number) => ["GMAIL_SEND_EMAIL"] },
    backgroundManager: { spawn: async () => ({}), list: () => [], get: () => undefined },
    memoryInjector: { inject: async () => [] },
    guideBridge: { request: async () => ({ found: true }), requestScreen: async () => ({ found: true }), requestWatch: async () => ({ found: true }) },
    webSearchEnabled: true,
    hotToolsN: 5,
    log: () => {},
    ...over,
  }
}

const names = (ts: Array<{ name: string }>) => ts.map((t) => t.name)

describe("buildActionToolset", () => {
  test("assembles the full toolset from live deps", async () => {
    const tools = await buildActionToolset(fullDeps())
    const n = names(tools)
    // dispatch pair + hot set
    expect(n).toContain("search_tools")
    expect(n).toContain("execute_tool")
    expect(n).toContain("GMAIL_SEND_EMAIL")
    // background + memory + web + guide
    expect(n).toContain("spawn_background_task")
    expect(n).toContain("background_tasks")
    expect(n).toContain("recall_memory")
    expect(n).toContain("web_search")
    expect(n).toContain("read_webpage")
    expect(n).toContain("guide_user")
    expect(n).toContain("read_screen")
  })

  test("every tool has the uniform ToolDef shape", async () => {
    for (const t of await buildActionToolset(fullDeps())) {
      expect(typeof t.name).toBe("string")
      expect(typeof t.description).toBe("string")
      expect(typeof (t as any).execute).toBe("function")
      expect(t.parameters && typeof t.parameters).toBe("object")
    }
  })

  test("de-dupes by name", async () => {
    const n = names(await buildActionToolset(fullDeps()))
    expect(n.length).toBe(new Set(n).size)
  })

  test("KAIROS_WEB_SEARCH=0 → no web tools", async () => {
    const n = names(await buildActionToolset(fullDeps({ webSearchEnabled: false })))
    expect(n).not.toContain("web_search")
    expect(n).not.toContain("read_webpage")
  })

  test("degrades gracefully: empty deps → no throw, empty-ish toolset", async () => {
    const tools = await buildActionToolset({ log: () => {} })
    expect(Array.isArray(tools)).toBe(true)
    // no Composio/guide/etc → no external-app tools, but never throws
    expect(names(tools)).not.toContain("search_tools")
  })

  test("a throwing builder dep is caught, not propagated (graceful degradation)", async () => {
    const bad = fullDeps({
      toolRetriever: { getByNames: () => { throw new Error("boom") }, search: async () => [] },
    })
    // hot-set throw is caught; the toolset still builds with the rest
    const tools = await buildActionToolset(bad)
    expect(Array.isArray(tools)).toBe(true)
    expect(names(tools)).toContain("web_search")
  })

  test("guide tools omitted when no bridge", async () => {
    const n = names(await buildActionToolset(fullDeps({ guideBridge: undefined })))
    expect(n).not.toContain("guide_user")
  })
})

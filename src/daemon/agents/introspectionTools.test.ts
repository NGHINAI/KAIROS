// src/daemon/agents/introspectionTools.test.ts
import { test, expect, mock } from "bun:test"
import { buildIntrospectionTools } from "./introspectionTools"

test("kairos_soul_read returns soul content", async () => {
  const tools = buildIntrospectionTools({
    soulLoader: { load: async () => "Name: Nirmal\nTone: casual" } as any,
    skillRegistry: { listActive: async () => [] } as any,
    ordersStore: { list: async () => [] } as any,
    semanticMemory: { add: async () => ({ id: 1 }), search: async () => [] } as any,
    episodicMemory: { recent: async () => [], search: async () => [] } as any,
    memoryStore: { read: async () => "(empty)" } as any,
    dreamLog: { last: async () => null, search: async () => [] } as any,
    connectionStore: { list: async () => [] } as any,
  })
  const soulReadTool = tools.find((t) => t.name === "kairos_soul_read")
  expect(soulReadTool).toBeDefined()
  const result = await soulReadTool!.execute({})
  expect(result.content).toContain("Nirmal")
})

test("kairos_skills_list returns list of active skill IDs", async () => {
  const tools = buildIntrospectionTools({
    soulLoader: { load: async () => "" } as any,
    skillRegistry: { listActive: async () => [{ id: "gmail", description: "Gmail tools" }, { id: "disk-space", description: "Check disk" }] } as any,
    ordersStore: { list: async () => [] } as any,
    semanticMemory: { add: async () => ({ id: 1 }), search: async () => [] } as any,
    episodicMemory: { recent: async () => [], search: async () => [] } as any,
    memoryStore: { read: async () => "" } as any,
    dreamLog: { last: async () => null, search: async () => [] } as any,
    connectionStore: { list: async () => [] } as any,
  })
  const tool = tools.find((t) => t.name === "kairos_skills_list")
  const result = await tool!.execute({})
  expect(result.skills).toContain("gmail")
  expect(result.skills).toContain("disk-space")
})

import { test, expect } from "bun:test"
import { buildOpenRouterModel, _resetOpenRouterClient } from "./agentsRouterAdapter"

test("buildOpenRouterModel returns a Model instance for the requested tier", () => {
  _resetOpenRouterClient()
  process.env.OPENROUTER_API_KEY = "sk-test"
  const model = buildOpenRouterModel("fast")
  expect(model).toBeDefined()
  expect((model as any).model).toBeTruthy()
})

test("buildOpenRouterModel throws if no API key", () => {
  _resetOpenRouterClient()
  delete process.env.OPENROUTER_API_KEY
  expect(() => buildOpenRouterModel("fast")).toThrow(/OPENROUTER_API_KEY/)
})

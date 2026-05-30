// src/daemon/agents/agentsRouterAdapter.ts
// Custom Model adapter for @openai/agents-js that talks to OpenRouter.

import { OpenAIChatCompletionsModel } from "@openai/agents"
import OpenAI from "openai"
import { TIER_MODELS, type Tier } from "./types"

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

let cachedClient: OpenAI | undefined

function getOpenAIClient(): OpenAI {
  if (cachedClient) return cachedClient
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY not set — required for agent LLM calls")
  }
  cachedClient = new OpenAI({
    apiKey,
    baseURL: OPENROUTER_BASE_URL,
    defaultHeaders: {
      "HTTP-Referer": "https://kairos.local",
      "X-Title": "KAIROS",
    },
  })
  return cachedClient
}

export function buildOpenRouterModel(tier: Tier): OpenAIChatCompletionsModel {
  const modelName = TIER_MODELS[tier]()
  const client = getOpenAIClient()
  const instance = new OpenAIChatCompletionsModel(client, modelName)
  // Expose the model name as a public property — @openai/agents stores it in a
  // private field (#model), so this surface lets tests and observability code
  // see which OpenRouter model was bound to this instance.
  Object.defineProperty(instance, "model", {
    value: modelName,
    writable: false,
    enumerable: true,
  })
  return instance
}

export function _resetOpenRouterClient(): void {
  cachedClient = undefined
}

import { test, expect } from "bun:test"
import { OpenRouterAdapter } from "./openRouterAdapter"

// Capture the request body the adapter sends, returning a minimal SSE [DONE] stream.
function captureFetch(cap: { body?: any }) {
  return async (_url: any, opts: any) => {
    cap.body = JSON.parse(opts.body)
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode("data: [DONE]\n")); c.close() },
    })
    return new Response(stream, { status: 200 })
  }
}

test("disableThinking sends reasoning.max_tokens:0 (truly disables thinking, not just hides it)", async () => {
  const cap: { body?: any } = {}
  const a = new OpenRouterAdapter({ apiKey: "x", defaultModel: "google/gemini-2.5-flash", disableThinking: true, fetchImpl: captureFetch(cap) as any })
  for await (const _ of a.stream({ messages: [{ role: "user", content: "hi" }] })) { /* drain */ }
  expect(cap.body.reasoning).toEqual({ exclude: true, max_tokens: 0 })
})

test("default adapter only EXCLUDES reasoning (model still thinks) — unchanged for the deep tier", async () => {
  const cap: { body?: any } = {}
  const a = new OpenRouterAdapter({ apiKey: "x", defaultModel: "minimax/minimax-m3", fetchImpl: captureFetch(cap) as any })
  for await (const _ of a.stream({ messages: [{ role: "user", content: "hi" }] })) { /* drain */ }
  expect(cap.body.reasoning).toEqual({ exclude: true })
})

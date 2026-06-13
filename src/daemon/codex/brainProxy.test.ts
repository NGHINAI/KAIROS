// brainProxy.test.ts — the hidden inference proxy, hermetic (mocked upstream).
// Edge cases the user asked for: auth, alias rewrite, the REAL key never coming
// from the client, streaming passthrough, retry/backoff (429 + Retry-After),
// 5xx exhaustion, network error, non-JSON body.
import { describe, expect, test } from "bun:test"
import { createBrainProxy, defaultAliasMap } from "./brainProxy"

type Call = { url: string; init: RequestInit }
function mockFetch(responder: (call: Call, attempt: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fn = (async (url: any, init: any) => {
    const call = { url: String(url), init: init ?? {} }
    calls.push(call)
    return responder(call, calls.length - 1)
  }) as unknown as typeof fetch
  return { fn, calls }
}

const BEARER = "tok-incoming"
const UPSTREAM_KEY = "sk-or-REAL-server-side"
function proxy(over: Partial<Parameters<typeof createBrainProxy>[0]> = {}, responder?: any) {
  const m = mockFetch(responder ?? (() => new Response(JSON.stringify({ object: "response", ok: true }), { status: 200, headers: { "content-type": "application/json" } })))
  const p = createBrainProxy({
    upstreamKey: UPSTREAM_KEY, expectedBearer: BEARER,
    aliasMap: { "kairos-smart": "minimax/minimax-m3", "kairos-deep": "minimax/minimax-m3" },
    fetchImpl: m.fn, sleep: async () => {}, log: () => {}, ...over,
  })
  return { p, calls: m.calls }
}
const post = (body: any, token = BEARER) =>
  new Request("http://127.0.0.1:9876/brain/v1/responses", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })

describe("bearer auth", () => {
  test("missing/wrong bearer → 401, never forwarded", async () => {
    const { p, calls } = proxy()
    expect((await p.handleRequest(new Request("http://x/brain/v1/responses", { method: "POST" }), "/v1/responses")).status).toBe(401)
    expect((await p.handleRequest(post({ model: "kairos-smart" }, "WRONG"), "/v1/responses")).status).toBe(401)
    expect(calls.length).toBe(0)
  })
  test("correct bearer forwards", async () => {
    const { p, calls } = proxy()
    const r = await p.handleRequest(post({ model: "kairos-smart", input: "hi" }), "/v1/responses")
    expect(r.status).toBe(200)
    expect(calls.length).toBe(1)
  })
})

describe("model alias rewrite + key injection", () => {
  test("alias → real slug in the forwarded body; effort/other fields preserved", async () => {
    const { p, calls } = proxy()
    await p.handleRequest(post({ model: "kairos-deep", input: "x", effort: "high", stream: false }), "/v1/responses")
    const sent = JSON.parse(String(calls[0]!.init.body))
    expect(sent.model).toBe("minimax/minimax-m3")
    expect(sent.effort).toBe("high")          // untouched
    expect(sent.input).toBe("x")
  })
  test("unknown model passes through unchanged", async () => {
    const { p, calls } = proxy()
    await p.handleRequest(post({ model: "openai/gpt-5", input: "x" }), "/v1/responses")
    expect(JSON.parse(String(calls[0]!.init.body)).model).toBe("openai/gpt-5")
  })
  test("the REAL upstream key is used, NOT the client's bearer", async () => {
    const { p, calls } = proxy()
    await p.handleRequest(post({ model: "kairos-smart" }), "/v1/responses")
    const auth = (calls[0]!.init.headers as any).authorization
    expect(auth).toBe(`Bearer ${UPSTREAM_KEY}`)
    expect(auth).not.toContain(BEARER)
  })
  test("forwards to the correct upstream subpath", async () => {
    const { p, calls } = proxy()
    await p.handleRequest(post({ model: "kairos-smart" }), "/v1/responses")
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/responses")
  })
})

describe("streaming passthrough", () => {
  test("stream:true → the upstream ReadableStream is returned unbuffered (SSE)", async () => {
    const sse = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"ok\"}\n\n"
    const { p } = proxy({}, () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(sse)); c.close() } }), { status: 200, headers: { "content-type": "text/event-stream" } }))
    const r = await p.handleRequest(post({ model: "kairos-smart", stream: true }), "/v1/responses")
    expect(r.headers.get("content-type")).toContain("event-stream")
    expect(await r.text()).toContain("response.output_text.delta")
  })
})

describe("resilience", () => {
  test("429 then 200 → retried, succeeds (honors Retry-After)", async () => {
    let n = 0
    const { p, calls } = proxy({ maxRetries: 2 }, () => {
      n++
      return n === 1
        ? new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
        : new Response(JSON.stringify({ object: "response" }), { status: 200, headers: { "content-type": "application/json" } })
    })
    const r = await p.handleRequest(post({ model: "kairos-smart" }), "/v1/responses")
    expect(r.status).toBe(200)
    expect(calls.length).toBe(2)
  })
  test("persistent 5xx → 503 after exhausting retries", async () => {
    const { p, calls } = proxy({ maxRetries: 2 }, () => new Response("boom", { status: 503 }))
    const r = await p.handleRequest(post({ model: "kairos-smart" }), "/v1/responses")
    expect(r.status).toBe(503)
    expect(calls.length).toBe(3)               // initial + 2 retries
  })
  test("network error → 502 after retries", async () => {
    const { p } = proxy({ maxRetries: 1 }, () => { throw new Error("ECONNREFUSED") })
    const r = await p.handleRequest(post({ model: "kairos-smart" }), "/v1/responses")
    expect(r.status).toBe(502)
    expect(await r.text()).toContain("upstream unreachable")
  })
  test("a non-retryable 400 is passed straight back (no retry)", async () => {
    const { p, calls } = proxy({ maxRetries: 2 }, () => new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400, headers: { "content-type": "application/json" } }))
    const r = await p.handleRequest(post({ model: "kairos-smart" }), "/v1/responses")
    expect(r.status).toBe(400)
    expect(calls.length).toBe(1)
  })
})

describe("robustness", () => {
  test("non-JSON body is forwarded as-is, no crash", async () => {
    const { p, calls } = proxy()
    const req = new Request("http://x/brain/v1/responses", { method: "POST", headers: { authorization: `Bearer ${BEARER}`, "content-type": "text/plain" }, body: "raw text" })
    const r = await p.handleRequest(req, "/v1/responses")
    expect(r.status).toBe(200)
    expect(String(calls[0]!.init.body)).toBe("raw text")
  })
})

describe("defaultAliasMap", () => {
  test("one model by default; env overrides per lane", () => {
    expect(defaultAliasMap({})["kairos-smart"]).toBe("minimax/minimax-m3")
    const m = defaultAliasMap({ KAIROS_BRAIN_MODEL_SMART: "a/b", KAIROS_BRAIN_MODEL_DEEP: "c/d" })
    expect(m["kairos-smart"]).toBe("a/b")
    expect(m["kairos-deep"]).toBe("c/d")
    expect(m["kairos"]).toBe("a/b")
  })
})

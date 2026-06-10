// src/daemon/agents/webTools.test.ts
import { test, expect } from "bun:test"
import { buildWebTools, parseDdgHtml, parseDdgLite, ddgHrefToUrl, isFetchableUrl, extractReadableText } from "./webTools"

const DDG_HTML = `
<div class="result results_links results_links_deep web-result">
  <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.kayak.com%2Fflights%2FNYC-SFO&amp;rut=abc">Cheap Flights NYC to <b>San Francisco</b></a>
  <a class="result__snippet" href="//x">Compare hundreds of <b>flight</b> deals from New York to San Francisco.</a>
</div>
<div class="result">
  <a rel="nofollow" class="result__a" href="https://www.google.com/travel/flights">Google Flights</a>
  <a class="result__snippet" href="//y">Find cheap flights and track prices.</a>
</div>`

const DDG_LITE = `
<table>
<tr><td><a rel="nofollow" href="https://www.expedia.com/flights">Expedia Flights</a></td></tr>
<tr><td class="result-snippet">Book flights with free cancellation.</td></tr>
</table>`

function fakeFetch(routes: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: any, _init?: any) => {
    const url = String(input)
    for (const [prefix, handler] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return handler()
    }
    return new Response("not found", { status: 404 })
  }) as any
}

// ── parsers ──

test("parseDdgHtml extracts decoded URLs, clean titles, paired snippets; skips ads", () => {
  const hits = parseDdgHtml(DDG_HTML)
  expect(hits.length).toBe(2)
  expect(hits[0]!.url).toBe("https://www.kayak.com/flights/NYC-SFO")
  expect(hits[0]!.title).toBe("Cheap Flights NYC to San Francisco")   // tags stripped
  expect(hits[0]!.snippet).toContain("flight deals")
  expect(hits[1]!.url).toBe("https://www.google.com/travel/flights")
})

test("parseDdgLite handles the fallback markup", () => {
  const hits = parseDdgLite(DDG_LITE)
  expect(hits.length).toBe(1)
  expect(hits[0]!.url).toBe("https://www.expedia.com/flights")
  expect(hits[0]!.snippet).toContain("free cancellation")
})

test("ddgHrefToUrl handles uddg redirects, protocol-relative, and junk", () => {
  expect(ddgHrefToUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.com%2Fb&rut=x")).toBe("https://a.com/b")
  expect(ddgHrefToUrl("https://direct.example.com")).toBe("https://direct.example.com")
  expect(ddgHrefToUrl("//cdn.example.com/x")).toBe("https://cdn.example.com/x")
  expect(ddgHrefToUrl("javascript:alert(1)")).toBeNull()
})

// ── web_search tool ──

test("web_search returns a readable text observation from the primary endpoint", async () => {
  const [search] = buildWebTools({
    fetchImpl: fakeFetch({ "https://html.duckduckgo.com": () => new Response(DDG_HTML, { status: 200 }) }),
  })
  const out = await search!.execute({ query: "flights NYC to SFO" })
  expect(typeof out).toBe("string")
  expect(out).toContain('results for "flights NYC to SFO"')
  expect(out).toContain("https://www.kayak.com/flights/NYC-SFO")
  expect(out).toContain("read_webpage")
})

test("web_search falls back to the lite endpoint when the primary fails", async () => {
  const [search] = buildWebTools({
    fetchImpl: fakeFetch({
      "https://html.duckduckgo.com": () => new Response("blocked", { status: 403 }),
      "https://lite.duckduckgo.com": () => new Response(DDG_LITE, { status: 200 }),
    }),
  })
  const out = await search!.execute({ query: "flights" })
  expect(out).toContain("expedia.com")
})

test("when both endpoints fail the model gets actionable guidance, not an exception", async () => {
  const [search] = buildWebTools({
    fetchImpl: (async () => { throw new Error("network down") }) as any,
  })
  const out = await search!.execute({ query: "anything" })
  expect(out).toContain("unreachable")
  expect(out).toContain("read_webpage")
})

test("web_search is read-only (concurrencySafe) and rejects empty queries", async () => {
  const [search] = buildWebTools({ fetchImpl: fakeFetch({}) })
  expect(search!.concurrencySafe).toBe(true)
  expect(await search!.execute({ query: " " })).toContain("non-empty")
})

// ── read_webpage tool ──

const PAGE = `<html><head><title>Flight Deals — Kayak</title><script>evil()</script>
<style>.x{}</style></head><body><nav>Home About</nav>
<h1>NYC to SFO</h1><p>Nonstop from $129 one-way in August.</p>
<p>Morning departures are cheapest on Tuesdays &amp; Wednesdays.</p>
<footer>©2026</footer></body></html>`

test("read_webpage returns title + readable text with scripts/nav/footer stripped", async () => {
  const [, read] = buildWebTools({
    fetchImpl: fakeFetch({ "https://www.kayak.com": () => new Response(PAGE, { status: 200, headers: { "content-type": "text/html" } }) }),
  })
  const out = await read!.execute({ url: "https://www.kayak.com/flights" })
  expect(out).toContain("# Flight Deals — Kayak")
  expect(out).toContain("Nonstop from $129")
  expect(out).toContain("Tuesdays & Wednesdays")    // entities decoded
  expect(out).not.toContain("evil()")
  expect(out).not.toContain("Home About")           // nav stripped
})

test("read_webpage blocks private/local targets and bad schemes (SSRF guard)", async () => {
  const [, read] = buildWebTools({ fetchImpl: fakeFetch({}) })
  for (const url of ["http://localhost:9876/admin", "http://127.0.0.1/x", "http://192.168.1.1/", "http://10.0.0.5/x", "file:///etc/passwd", "ftp://x.com"]) {
    const out = await read!.execute({ url })
    expect(out).toContain("Can't fetch")
  }
  expect(isFetchableUrl("https://example.com").ok).toBe(true)
})

test("read_webpage teaches on HTTP errors instead of throwing", async () => {
  const [, read] = buildWebTools({
    fetchImpl: fakeFetch({ "https://gone.example.com": () => new Response("", { status: 404 }) }),
  })
  const out = await read!.execute({ url: "https://gone.example.com/x" })
  expect(out).toContain("HTTP 404")
  expect(out).toContain("web_search")
})

test("read_webpage clamps very long pages head-weighted with a continuation marker", async () => {
  const long = `<html><head><title>Long</title></head><body><p>${"start ".repeat(500)}</p><p>${"middle ".repeat(2000)}</p><p>UNIQUE_TAIL_MARKER</p></body></html>`
  const [, read] = buildWebTools({
    fetchImpl: fakeFetch({ "https://long.example.com": () => new Response(long, { status: 200, headers: { "content-type": "text/html" } }) }),
  })
  const out = await read!.execute({ url: "https://long.example.com/" })
  expect(out.length).toBeLessThan(10_000)
  expect(out).toContain("(page continues)")
  expect(out).toContain("UNIQUE_TAIL_MARKER")       // tail survives the clamp
})

test("extractReadableText keeps paragraph structure", () => {
  const { title, text } = extractReadableText(PAGE)
  expect(title).toBe("Flight Deals — Kayak")
  expect(text.split("\n").length).toBeGreaterThan(1)
})

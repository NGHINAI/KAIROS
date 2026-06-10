// src/daemon/agents/webTools.ts
// Built-in web access for the agent: web_search + read_webpage. FREE (no API key):
// primary backend is DuckDuckGo's HTML endpoint, fallback is the lite endpoint.
// This closes the capability gap behind the 2026-06-10 "research flights" session,
// where the planner had NOTHING to research with and hallucinated ("I've started
// looking into flights…") — for anything on the public web, the agent now has a
// real tool instead of a dead end.
//
// Both tools return TEXT (strings pass the tool-result shaper losslessly) and are
// read-only (concurrencySafe, listed in the verifier's LOCAL_TOOLS so they are
// never approval-gated). Production hygiene: timeouts via AbortController, real
// browser UA, SSRF guard on read_webpage (no localhost/private ranges/file:),
// teaching errors the model can act on, bounded output.

import type { ToolDef } from "./types"

export interface WebToolsDeps {
  fetchImpl?: typeof fetch
  /** Override the search/page timeout (ms). Env: KAIROS_WEB_TIMEOUT_MS. */
  timeoutMs?: number
}

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"

const RESULT_MAX = 8           // search results returned to the model
const SNIPPET_MAX = 200        // chars per snippet
const PAGE_TEXT_MAX = 9000     // chars of extracted page text (head-weighted)
const PAGE_BYTES_MAX = 2_000_000

const timeoutOf = (deps?: WebToolsDeps) =>
  deps?.timeoutMs ?? (Number(process.env.KAIROS_WEB_TIMEOUT_MS) || 12_000)

function withDeadline(ms: number): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), ms)
  return { signal: ac.signal, done: () => clearTimeout(t) }
}

// ── HTML helpers (no DOM dependency — regex extraction on known-shape markup) ──

const ENTITIES: Record<string, string> = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&#x27;": "'", "&nbsp;": " ",
}
export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)) } catch { return " " } })
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (m) => ENTITIES[m] ?? " ")
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
}

/** Extract the destination URL from a DuckDuckGo redirect href (uddg param). */
export function ddgHrefToUrl(href: string): string | null {
  try {
    const h = decodeEntities(href)
    const m = /[?&]uddg=([^&]+)/.exec(h)
    if (m) return decodeURIComponent(m[1]!)
    if (/^https?:\/\//.test(h)) return h
    if (h.startsWith("//")) return "https:" + h
    return null
  } catch { return null }
}

type SearchHit = { title: string; url: string; snippet: string }

/** Parse DuckDuckGo's html.duckduckgo.com results page. */
export function parseDdgHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]!))
  let m: RegExpExecArray | null
  let i = 0
  while ((m = linkRe.exec(html)) !== null && hits.length < RESULT_MAX) {
    const url = ddgHrefToUrl(m[1]!)
    const title = stripTags(m[2]!)
    const snippet = (snippets[i++] ?? "").slice(0, SNIPPET_MAX)
    if (!url || !title) continue
    if (/duckduckgo\.com\/y\.js|ad_domain=/.test(url)) continue   // sponsored
    hits.push({ title, url, snippet })
  }
  return hits
}

/** Parse the lite.duckduckgo.com fallback page (plain table markup). */
export function parseDdgLite(html: string): SearchHit[] {
  const hits: SearchHit[] = []
  const linkRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g
  const snippetRe = /class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/g
  const snippets: string[] = []
  let sm: RegExpExecArray | null
  while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripTags(sm[1]!))
  let m: RegExpExecArray | null
  let i = 0
  while ((m = linkRe.exec(html)) !== null && hits.length < RESULT_MAX) {
    const url = ddgHrefToUrl(m[1]!)
    const title = stripTags(m[2]!)
    if (!url || !title) continue
    hits.push({ title, url, snippet: (snippets[i++] ?? "").slice(0, SNIPPET_MAX) })
  }
  return hits
}

function renderHits(query: string, hits: SearchHit[]): string {
  const lines = hits.map((h, i) => `${i + 1}. ${h.title} — ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`)
  return (
    `Top ${hits.length} web results for "${query}" (use read_webpage on a URL for details):\n` +
    lines.join("\n")
  )
}

// ── SSRF guard for read_webpage ──────────────────────────────────────────────

export function isFetchableUrl(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL
  try { url = new URL(raw) } catch { return { ok: false, reason: "not a valid absolute URL" } }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `unsupported scheme "${url.protocol}" — only http(s)` }
  }
  const host = url.hostname.toLowerCase()
  const PRIVATE =
    host === "localhost" || host === "0.0.0.0" || host === "[::1]" || host === "::1" ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) || /^169\.254\./.test(host)
  if (PRIVATE) return { ok: false, reason: "local/private addresses are not reachable from this tool" }
  return { ok: true, url }
}

/** HTML → readable text: drop non-content blocks, strip tags, keep the title. */
export function extractReadableText(html: string): { title: string; text: string } {
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)
  const title = titleM ? stripTags(titleM[1]!).slice(0, 200) : ""
  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
  // Keep paragraph-ish structure readable for the model.
  body = body.replace(/<(\/p|br\s*\/?|\/h[1-6]|\/li|\/tr)>/gi, "\n")
  const text = decodeEntities(body.replace(/<[^>]+>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n")
    .trim()
  return { title, text }
}

export function buildWebTools(deps: WebToolsDeps = {}): ToolDef[] {
  const fetchImpl = deps.fetchImpl ?? fetch

  const webSearch: ToolDef = {
    name: "web_search",
    concurrencySafe: true,
    description:
      "Search the public web for CURRENT information: prices, flights, travel, news, products, businesses, facts, anything not in the user's connected apps. " +
      "Returns titles, URLs and snippets — follow up with read_webpage on a promising URL for the actual details. Always available; no setup needed.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Plain search query (e.g. 'nonstop flights NYC to San Francisco August prices')" },
      },
      required: ["query"],
    },
    execute: async (args: { query: string }) => {
      const query = String(args?.query ?? "").trim()
      if (!query) return "Give web_search a non-empty query."
      const ms = timeoutOf(deps)

      // Primary: html.duckduckgo.com (form POST — the most stable free endpoint).
      try {
        const dl = withDeadline(ms)
        try {
          const resp = await fetchImpl("https://html.duckduckgo.com/html/", {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": UA, accept: "text/html" },
            body: `q=${encodeURIComponent(query)}&kl=us-en`,
            signal: dl.signal,
          })
          if (resp.ok) {
            const hits = parseDdgHtml(await resp.text())
            if (hits.length > 0) return renderHits(query, hits)
          }
        } finally { dl.done() }
      } catch { /* fall through to the lite endpoint */ }

      // Fallback: lite.duckduckgo.com (different markup, same vendor, lighter page).
      try {
        const dl = withDeadline(ms)
        try {
          const resp = await fetchImpl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
            headers: { "user-agent": UA, accept: "text/html" },
            signal: dl.signal,
          })
          if (resp.ok) {
            const hits = parseDdgLite(await resp.text())
            if (hits.length > 0) return renderHits(query, hits)
          }
        } finally { dl.done() }
      } catch { /* both failed */ }

      return (
        "Web search is unreachable right now (provider blocked or network down). " +
        "If you know a relevant URL, try read_webpage on it directly; otherwise tell the user plainly that live web search failed."
      )
    },
  }

  const readWebpage: ToolDef = {
    name: "read_webpage",
    concurrencySafe: true,
    description:
      "Fetch a public web page and return its readable text (scripts/navigation stripped). " +
      "Use after web_search to get the actual details from a result URL. http(s) only.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Absolute http(s) URL, e.g. from web_search results" },
      },
      required: ["url"],
    },
    execute: async (args: { url: string }) => {
      const raw = String(args?.url ?? "").trim()
      const check = isFetchableUrl(raw)
      if (!check.ok) return `Can't fetch that URL: ${check.reason}.`
      const ms = timeoutOf(deps)
      const dl = withDeadline(ms)
      try {
        const resp = await fetchImpl(check.url.toString(), {
          headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
          signal: dl.signal,
          redirect: "follow",
        })
        if (!resp.ok) {
          return `The page returned HTTP ${resp.status}. Try a different result URL from web_search.`
        }
        const ct = resp.headers.get("content-type") ?? ""
        const bodyText = await resp.text()
        if (bodyText.length > PAGE_BYTES_MAX) {
          return `That page is too large to read (${Math.round(bodyText.length / 1024)}KB). Try a more specific page.`
        }
        if (/json/i.test(ct)) return bodyText.slice(0, PAGE_TEXT_MAX)
        const { title, text } = extractReadableText(bodyText)
        if (!text) return "The page had no readable text (likely a JavaScript-only app). Try a different result URL."
        const clipped = text.length > PAGE_TEXT_MAX
          ? text.slice(0, Math.floor(PAGE_TEXT_MAX * 0.8)) + "\n…(page continues)…\n" + text.slice(-Math.floor(PAGE_TEXT_MAX * 0.18))
          : text
        return (title ? `# ${title}\n` : "") + clipped
      } catch (e) {
        const msg = (e as Error)?.name === "AbortError" ? "timed out" : (e as Error).message
        return `Couldn't fetch the page (${msg}). Try a different result URL from web_search.`
      } finally { dl.done() }
    },
  }

  return [webSearch, readWebpage]
}

// src/daemon/agents/toolRetriever.test.ts
import { test, expect } from "bun:test"
import { ToolRetriever } from "./toolRetriever"

// Deterministic fake embedder: vector = counts over a fixed vocab. Words outside
// the vocab contribute nothing to the DENSE signal (so BM25 must catch them).
const VOCAB = ["linear", "issue", "email", "send", "slack", "message", "calendar", "event"]
function fakeEmbed(text: string): Float32Array {
  const v = new Float32Array(VOCAB.length)
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (const t of toks) { const i = VOCAB.indexOf(t); if (i >= 0) v[i] += 1 }
  return v
}
const fakeEmbedder = { embedBatch: async (texts: string[]) => texts.map(fakeEmbed) }

const DOCS = [
  { name: "LINEAR_LIST_ISSUES", toolkit: "linear", description: "List issues", hints: ["show my linear issues", "what issues do I have"] },
  { name: "GMAIL_SEND_EMAIL", toolkit: "gmail", description: "Send an email", hints: ["send an email", "email someone"] },
  { name: "SLACK_SEND_MESSAGE", toolkit: "slack", description: "Send a slack message", hints: ["message my team on slack"] },
  { name: "GCAL_CREATE_EVENT", toolkit: "googlecalendar", description: "Create a calendar event", hints: ["add a calendar event"] },
  { name: "KLAVIYO_SEND_CAMPAIGN", toolkit: "klaviyo", description: "Send a Klaviyo campaign blast", hints: ["send a klaviyo campaign"] },
]

test("retrieves the semantically relevant tool first (dense)", async () => {
  const r = new ToolRetriever({ embedder: fakeEmbedder })
  await r.index(DOCS as any)
  const hits = await r.retrieve("show my linear issues", 2)
  expect(hits[0]!.name).toBe("LINEAR_LIST_ISSUES")
})

test("hybrid: BM25 catches a proper-noun the dense vectors miss (Klaviyo)", async () => {
  const r = new ToolRetriever({ embedder: fakeEmbedder })
  await r.index(DOCS as any)
  // "klaviyo" is NOT in the dense vocab → dense signal is blind to it; BM25 must surface it.
  const hits = await r.retrieve("send a klaviyo campaign", 3)
  expect(hits.map((h) => h.name)).toContain("KLAVIYO_SEND_CAMPAIGN")
})

test("respects k (returns at most k tools)", async () => {
  const r = new ToolRetriever({ embedder: fakeEmbedder })
  await r.index(DOCS as any)
  const hits = await r.retrieve("send an email", 2)
  expect(hits.length).toBe(2)
})

test("empty index returns []", async () => {
  const r = new ToolRetriever({ embedder: fakeEmbedder })
  const hits = await r.retrieve("anything", 5)
  expect(hits).toEqual([])
})

test("size() reflects indexed docs", async () => {
  const r = new ToolRetriever({ embedder: fakeEmbedder })
  await r.index(DOCS as any)
  expect(r.size()).toBe(DOCS.length)
})

test("getByNames returns the indexed docs matching the given tool names (for the hot-set)", async () => {
  const r = new ToolRetriever({ embedder: fakeEmbedder })
  await r.index(DOCS as any)
  const hot = r.getByNames(["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE", "NOPE"])
  expect(hot.map((d) => d.name).sort()).toEqual(["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE"])
})

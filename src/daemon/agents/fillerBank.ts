// src/daemon/agents/fillerBank.ts
// INSTANT (no-LLM) spoken filler/ack phrases for the live streaming voice path.
// Fed the moment a tool starts and during long waits — latency-free (an LLM call
// would defeat the dead-air purpose). DATA-AWARE: derives the real app, action, and
// target from the tool name + args, so KAIROS says "Okay, sending that email to Sam
// now" or "Let me pull up your Linear issues" — not a generic "On it." It's warm,
// concise, non-repeating, and falls back to a generic bank when it can't parse.
//
// The richer LLM-driven acks/transitions (executorAgent.ts) still run on
// non-streaming paths; this is the zero-latency bank for the streaming tier.

// Internal/instant tools never get an ack — they return immediately.
const SILENT_TOOLS = new Set(["search_tools", "update_plan", "background_tasks"])

// Composio toolkit slug → friendly spoken app name. Unknowns fall back to titlecase.
const APP_NAMES: Record<string, string> = {
  GMAIL: "Gmail", GOOGLECALENDAR: "your calendar", GOOGLECALENDAR_V2: "your calendar",
  GOOGLEDRIVE: "your Drive", GOOGLEDOCS: "your docs", GOOGLESHEETS: "your sheets",
  GOOGLEMEET: "Google Meet", LINEAR: "Linear", SLACK: "Slack", GITHUB: "GitHub",
  GITLAB: "GitLab", NOTION: "Notion", JIRA: "Jira", ASANA: "Asana", TRELLO: "Trello",
  CLICKUP: "ClickUp", HUBSPOT: "HubSpot", SALESFORCE: "Salesforce", DISCORD: "Discord",
  TELEGRAM: "Telegram", OUTLOOK: "Outlook", MICROSOFTTEAMS: "Teams", ZOOM: "Zoom",
  STRIPE: "Stripe", SHOPIFY: "Shopify", AIRTABLE: "Airtable", TWITTER: "Twitter",
  REDDIT: "Reddit", YOUTUBE: "YouTube", SPOTIFY: "Spotify", DROPBOX: "Dropbox",
  ZENDESK: "Zendesk", INTERCOM: "Intercom", CALENDLY: "Calendly", TODOIST: "Todoist",
}

// Verb segment → gerund + imperative base + class (look = read-only, do = mutating).
const VERBS: Record<string, { ger: string; base: string; kind: "look" | "do" }> = {
  LIST: { ger: "pulling up", base: "pull up", kind: "look" },
  GET: { ger: "grabbing", base: "grab", kind: "look" },
  FETCH: { ger: "checking", base: "check", kind: "look" },
  SEARCH: { ger: "searching", base: "search", kind: "look" },
  FIND: { ger: "finding", base: "find", kind: "look" },
  READ: { ger: "reading", base: "read", kind: "look" },
  RETRIEVE: { ger: "pulling up", base: "pull up", kind: "look" },
  SEND: { ger: "sending", base: "send", kind: "do" },
  CREATE: { ger: "creating", base: "create", kind: "do" },
  UPDATE: { ger: "updating", base: "update", kind: "do" },
  EDIT: { ger: "updating", base: "update", kind: "do" },
  ADD: { ger: "adding", base: "add", kind: "do" },
  DELETE: { ger: "deleting", base: "delete", kind: "do" },
  REMOVE: { ger: "removing", base: "remove", kind: "do" },
  POST: { ger: "posting", base: "post", kind: "do" },
  MOVE: { ger: "moving", base: "move", kind: "do" },
  ASSIGN: { ger: "assigning", base: "assign", kind: "do" },
  SCHEDULE: { ger: "scheduling", base: "schedule", kind: "do" },
  REPLY: { ger: "replying", base: "reply", kind: "do" },
  ARCHIVE: { ger: "archiving", base: "archive", kind: "do" },
}

const ACKS_LOOK = ["Let me look.", "Pulling that up.", "Checking now.", "One sec, checking.", "Looking that up.", "Let me dig that up."]
const ACKS_DO = ["On it.", "Doing that now.", "Right away.", "On it — one sec.", "Getting that done.", "Okay, on it."]
const ACKS_CONNECT = ["Setting that up.", "On it — getting that connected.", "Let me wire that up."]
const ACKS_GENERIC = ["On it.", "One sec.", "Sure thing.", "Let me get that.", "Right on it.", "Gotcha — one sec."]
const FILLERS = ["Still on it.", "Almost there.", "Hang tight.", "Nearly there.", "Still working on it.", "Won't be long.", "Bear with me.", "Just a moment more."]

let lastPhrase = ""

/** The effective action name — unwrap execute_tool's wrapped Composio tool_name. */
function effectiveName(toolName: string, args: any): string {
  if (toolName === "execute_tool") return String(args?.tool_name ?? "")
  return toolName
}

/** The inner Composio args (execute_tool nests them under args.args). */
function innerArgs(args: any): any {
  return args?.args && typeof args.args === "object" ? args.args : (args ?? {})
}

function cap(s: string): string { return s ? s[0]!.toUpperCase() + s.slice(1) : s }
function titlecase(s: string): string { return s ? s[0]!.toUpperCase() + s.slice(1).toLowerCase() : s }
function basename(p: any): string { const s = String(p ?? ""); return (s.split("/").pop() || s).trim() }

/** A clean spoken name from a recipient/email/handle ("sam@x.com" → "Sam"). */
function prettyName(v: any): string {
  let s = String(v ?? "").trim()
  if (!s) return ""
  if (s.includes("@")) s = s.split("@")[0]!
  s = s.split(/[._\-\s]/)[0]!
  return s ? s[0]!.toUpperCase() + s.slice(1) : ""
}

/** " to Sam" / " for the budget doc" / "" — a short spoken target from the args. */
function extractTarget(args: any): string {
  const ia = innerArgs(args)
  const to = ia.to ?? ia.recipient ?? ia.recipient_email ?? ia.email ?? args?.to
  if (to) { const n = prettyName(Array.isArray(to) ? to[0] : to); if (n) return ` to ${n}` }
  const q = ia.query ?? ia.q ?? ia.search ?? ia.search_query ?? ia.keywords
  if (q) return ` for ${String(q).slice(0, 28)}`
  return ""
}

export interface ActionDesc {
  app?: string
  base?: string         // imperative ("send", "pull up")
  ger?: string          // gerund ("sending", "pulling up")
  objPhrase?: string    // article-applied noun phrase ("that email", "your issues", "git")
  target: string        // " to Sam" / ""
  kind: "look" | "do" | "connect" | "unknown"
  noun: string          // for fillers ("that email", "your issues", "Gmail")
}

/** Parse a tool call into the pieces needed to speak about it like a human. */
export function describeAction(toolName: string, args: any): ActionDesc {
  const ia = innerArgs(args)
  // ── system tools ────────────────────────────────────────────────────────
  if (toolName === "write_file") { const f = basename(ia.path); const o = f ? `the file ${f}` : "that file"; return { ger: "writing", base: "write", objPhrase: o, target: "", kind: "do", noun: o } }
  if (toolName === "read_file") { const f = basename(ia.path); const o = f || "that file"; return { ger: "reading", base: "read", objPhrase: o, target: "", kind: "look", noun: o } }
  if (toolName === "list_dir") { const f = basename(ia.path) || "the folder"; return { ger: "checking", base: "check", objPhrase: f, target: "", kind: "look", noun: f } }
  if (toolName === "run_shell") { const t = String(ia.command ?? "").trim().split(/\s+/)[0] ?? ""; const c = /^[a-z][\w.-]*$/i.test(t) ? t : ""; const o = c || "that command"; return { ger: "running", base: "run", objPhrase: o, target: "", kind: "do", noun: o } }

  const eff = effectiveName(toolName, args)
  // ── connect / setup ─────────────────────────────────────────────────────
  if (eff === "connect_service" || /^CONNECT|_CONNECT|SETUP|AUTH/i.test(eff)) {
    const tk = String(ia.toolkit_slug ?? ia.toolkit ?? "").toUpperCase()
    const app = APP_NAMES[tk] ?? (tk ? titlecase(tk) : "")
    return { app: app || undefined, target: "", kind: "connect", noun: app || "that" }
  }

  // ── Composio TOOLKIT_VERB_OBJECT (e.g. GMAIL_SEND_EMAIL, LINEAR_LIST_ISSUES) ──
  const parts = eff.split("_").filter(Boolean)
  if (parts.length >= 2) {
    const tk = parts[0]!.toUpperCase()
    const app = APP_NAMES[tk] ?? titlecase(parts[0]!)
    const v = VERBS[parts[1]!.toUpperCase()]
    const object = parts.slice(2).join(" ").toLowerCase()
    const target = extractTarget(args)
    if (v) {
      const objPhrase = object ? (v.kind === "do" ? `that ${object}` : `your ${object}`) : undefined
      return { app, base: v.base, ger: v.ger, objPhrase, target, kind: v.kind, noun: objPhrase ?? app }
    }
    return { app, target, kind: "unknown", noun: app }
  }
  return { target: "", kind: "unknown", noun: "that" }
}

/** Build varied, data-aware ack candidates (empty → caller uses the generic bank). */
function composeAckCandidates(d: ActionDesc): string[] {
  const out: string[] = []
  if (d.kind === "connect" && d.app) {
    out.push(`Getting ${d.app} connected.`, `Setting up ${d.app} — one sec.`, `Connecting ${d.app} now.`)
  } else if (d.kind === "do") {
    if (d.ger && d.objPhrase) out.push(`Okay, ${d.ger} ${d.objPhrase}${d.target} now.`, `${cap(d.ger)} ${d.objPhrase}${d.target} — one sec.`)
    if (d.app) out.push(`Okay, opening ${d.app} now — one sec.`)
  } else if (d.kind === "look") {
    const obj = d.objPhrase ?? d.app ?? "that"
    if (d.base) out.push(`Let me ${d.base} ${obj}.`, `One sec — ${d.ger ?? "checking"} ${obj}.`)
    out.push(`Checking ${obj} now.`)
    if (d.app && !d.objPhrase) out.push(`Let me check ${d.app}.`)
  } else if (d.app) {
    out.push(`Okay, opening ${d.app} now — one sec.`, `One sec — opening ${d.app}.`)
  }
  return out.filter((s) => s && s.length <= 90)
}

/** Pick a phrase from candidates, never repeating the immediately-previous one. */
function pick(bank: string[]): string {
  const choices = bank.length > 1 ? bank.filter((p) => p !== lastPhrase) : bank
  const phrase = choices[Math.floor(Math.random() * choices.length)] ?? bank[0]!
  lastPhrase = phrase
  return phrase
}

function genericBankFor(name: string): string[] {
  const n = name.toUpperCase()
  if (/CONNECT|SETUP|AUTH/.test(n)) return ACKS_CONNECT
  if (/(_LIST|_GET|_SEARCH|_FETCH|_READ|LIST_|GET_|SEARCH_|FIND_)/.test(n) || /read_file|list_dir/i.test(name)) return ACKS_LOOK
  if (/SEND|CREATE|UPDATE|POST|ADD|DELETE|REMOVE|SCHEDULE|BOOK|WRITE|MOVE|ASSIGN|PAY/.test(n) || /run_shell|write_file/i.test(name)) return ACKS_DO
  return ACKS_GENERIC
}

/** Instant, DATA-AWARE ack spoken the moment a (non-instant) tool starts. "" = skip. */
export function pickAck(toolName: string, args?: any): string {
  if (SILENT_TOOLS.has(toolName)) return ""
  const name = effectiveName(toolName, args)
  if (!name) return pick(ACKS_GENERIC)
  const dataAware = composeAckCandidates(describeAction(toolName, args))
  if (dataAware.length) return pick(dataAware)
  return pick(genericBankFor(name)) // fallback when we can't parse the tool
}

/** Instant "still working" filler for long waits — optionally references the action. */
export function pickFiller(actionNoun?: string): string {
  const n = (actionNoun ?? "").trim()
  const candidates = n && n !== "that"
    ? [...FILLERS, `Still on ${n}.`, `Almost done with ${n}.`, `Still working on ${n}.`]
    : FILLERS
  return pick(candidates)
}

/** Test hook: reset the no-repeat memory. */
export function __resetFillerBank(): void { lastPhrase = "" }

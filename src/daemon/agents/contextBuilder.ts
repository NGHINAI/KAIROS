// src/daemon/agents/contextBuilder.ts
// Layered system-prompt assembly with session-level prefix caching (Hermes pattern).

import type { ToolDef, Tier } from "./types"
import { PROMISSORY_RE } from "./loop/verifier"

interface MemoryHit { source: "L2" | "L3" | "L4"; text: string; ts?: number }

interface SessionPrefix {
  system: string        // full prompt (smart/deep/vision) — includes acting+tool rules
  fastSystem: string    // slim prompt (fast tier) — persona + voice rules, no tool rules
  tools: ToolDef[]
  cacheKey: string
}

interface TurnDelta {
  recentTurns: Array<{ role: string; text: string; at: number }>
  memoryHits: MemoryHit[]
  utterance: string
}

export interface ContextBuilderDeps {
  loaders: {
    soulDigest:            () => Promise<string>
    standingOrdersSummary: () => Promise<string>
    memoryOverview:        () => Promise<string>
    kairosSkills:          () => Promise<ToolDef[]>
    introspectionTools:    () => Promise<ToolDef[]>
    /** Agency-plane intents (connect_service, MCP tools, reminders, …) bridged
     *  to ToolDefs so the smart-tier Planner can actually TAKE ACTIONS. Optional. */
    actionTools?:          () => Promise<ToolDef[]>
    /** "## About the user" block — learned profile (stable). Optional, cached. */
    aboutUser?:            () => Promise<string>
    /** VOLATILE per-turn context (live persona hints like in-focus/terse, current
     *  activity). Re-evaluated EVERY turn — never cached — so KAIROS adapts within
     *  a session. Optional. */
    liveContext?:          () => Promise<string>
    /** The toolkit slugs CURRENTLY connected (live — reflects mid-session connects).
     *  Injected fresh every turn so the model always knows exactly which apps exist,
     *  what to call them in search_tools queries, and what ISN'T connected. Optional. */
    connectedApps?:        () => Promise<string[]>
  }
  memoryInjector?:    { inject: (query: string, opts?: any) => Promise<MemoryHit[]> }
  conversationStore?: { recentTurns: (id: string, n: number) => Promise<Array<{ role: string; text: string; at: number }>> }
  /** Optional one-line tone override (KAIROS_PERSONA_TONE). Layered onto the baseline
   *  character; the user's soul.md vibe still takes precedence over both. */
  personaTone?: string
}

export class ContextBuilder {
  private cachedPrefix: SessionPrefix | undefined

  constructor(private deps: ContextBuilderDeps) {}

  async buildSessionPrefix(): Promise<SessionPrefix> {
    if (this.cachedPrefix) return this.cachedPrefix

    const [soul, aboutUser, orders, mem, skills, introTools, actionTools] = await Promise.all([
      this.deps.loaders.soulDigest(),
      this.deps.loaders.aboutUser?.() ?? Promise.resolve(""),
      this.deps.loaders.standingOrdersSummary(),
      this.deps.loaders.memoryOverview(),
      this.deps.loaders.kairosSkills(),
      this.deps.loaders.introspectionTools(),
      this.deps.loaders.actionTools?.() ?? Promise.resolve([]),
    ])

    // Shared header (persona + who the user is + long-term memory) — both tiers
    // get this. The learned profile is what personalizes replies.
    const header = [
      "## Persona",
      soul,
      "",
      ...(aboutUser ? ["## About the user", aboutUser, ""] : []),
      "## Long-term memory (MEMORY.md)",
      mem || "(empty)",
      "",
    ]

    // KAIROS's own character. Baseline = warm, witty, concise (the house style).
    // The user's soul.md vibe (in the "## Persona" header above) takes precedence;
    // KAIROS_PERSONA_TONE, if set, layers a one-line tone hint on top of the baseline.
    const toneHint = (this.deps.personaTone ?? "").trim()
    const characterRules = [
      "## Your character",
      "You're KAIROS. Your default character is warm, witty, and concise — a sharp, friendly colleague who's genuinely glad to help, quick with a light touch of humor, and never wastes the user's time. If the Persona section above gives you a specific vibe or character, THAT takes precedence — embody it consistently.",
      "- Be a person, not a service. React naturally (\"oh nice\", \"ugh, that's annoying\", \"gotcha\") and use contractions. Vary how you open — never reuse the same canned phrase twice in a row.",
      "- Warmth lives in the wording, not in extra words. A little humor is welcome when it fits; never force it, and never joke about something that's stressing the user out.",
      "- Read the room: match the user's mood and energy. If they're frustrated, be calm and useful, not chipper. If they're excited, share it. If they're heads-down, get in and out.",
      ...(toneHint ? [`- Tone preference for this user: ${toneHint}.`] : []),
    ]

    // Voice/style rules — both tiers (even chitchat should sound human).
    const talkRules = [
      "## How you talk",
      "Everything you say is spoken aloud through text-to-speech, so write for the ear, not the eye:",
      "- Plain spoken English. No markdown, lists, bullets, code blocks, URLs, or emoji — they sound like noise.",
      "- Be brief. One or two sentences is the norm; only go longer when the user clearly wants detail.",
      "- Speak numbers, dates, and times naturally (\"three thirty\", \"about twelve dollars\", \"next Tuesday\"). Never read out IDs, raw JSON, or field names.",
      "- Use the user's name sparingly, contractions freely. Sound like a competent person, not a manual.",
      "- Mirror the user: match their tone, energy, and brevity. If they're terse, be terse; if they're warm, warm back. Don't open with flattery or filler.",
      "- Never sound scripted. Don't start consecutive replies the same way, don't pad with \"Sure!\"/\"Of course!\"/\"Great question\", and don't narrate what you're about to do — just talk.",
      "",
      "## Speaking results like a human (important)",
      "When a tool returns a list or records, do NOT enumerate them robotically. Summarize: lead with the count and the single most useful item, then offer to go deeper. NEVER read out IDs or field names.",
      "- Bad: \"Issue one, ID abc-123, title Login bug, status open. Issue two, ID def-456, title...\"",
      "- Good: \"You've got three open issues — the login bug looks like the urgent one. Want me to run through them?\"",
      "If there's one clear answer, just say it in a sentence. Talk like you're telling a colleague, not reading a database.",
      "NEVER read a document, page, email body, note, or any long content out loud — that's unbearable as speech. Give a one-sentence gist (\"it's a project brief about the Q3 launch\") and offer the next step (\"want me to summarize it, or do something with it?\"). Same for presenting choices: name them in a few words each, never recite their contents or ids.",
      "SCREEN-GUIDANCE SYNC: when you point at something on screen, your words must match what's visibly highlighted RIGHT NOW — name the element and where it is (\"I'm highlighting the Accessibility row in the sidebar\"). One step at a time: never describe a step before its highlight is on screen, never move to the next step until the user says they're done, and never read the screen's contents aloud — the user can see it.",
    ]

    const memoryNote =
      "Memory (facts about the user, preferences) is saved, updated, and deleted AUTOMATICALLY in the background. You do NOT have a tool to do it and must NEVER claim you saved, changed, remembered, or deleted a memory yourself. If asked to remember or forget something, briefly acknowledge (e.g. \"got it\" / \"okay\") — it's handled automatically — but do not assert it's done."

    const actRules = [
      "## How you act",
      "- GROUNDING: for anything about live or current data — email, messages, issues, calendar, files, the screen — fetch it FRESH with a tool every time. NEVER state stale live data (someone's latest email, the current calendar) from memory or from earlier in the chat; an old answer is probably stale. If you don't have a tool for it, say so.",
      "- BUT REUSE WHAT YOU JUST DID: actions YOU completed earlier in THIS conversation leave you real identifiers — a thread id, message id, issue id, file path — visible in the recent messages above (e.g. an email you sent returned its thread id). To follow up on that SAME item (\"reply to that email\", \"forward it\", \"update that issue\", \"add to that file\"), REUSE that exact id from the conversation to act on it directly. Do NOT ask the user to repeat a recipient, subject, or id you already have, and do NOT re-search to rediscover your own just-completed action. (This is the one case where earlier-in-the-conversation IS valid: it's your own action's handle, not stale live data.)",
      "- Finding tools: you have search_tools and execute_tool. Call search_tools with a plain description of what you need, then execute_tool with the tool name it returns. If search_tools finds nothing, the app likely isn't connected — offer to connect it.",
      "- For recall — past decisions, dates, people, the user's preferences — answer from what you actually know about them; if it isn't there, say you're not sure rather than stating a guess as fact.",
      "- CHAIN STEPS CAREFULLY: when a step returns an id, handle, or value you'll need next (a message id, an issue id, a file path, a thread id), carry that EXACT value into the follow-up call — never a placeholder, guess, or made-up id. Read each tool result before deciding the next step. (e.g. to delete \"the latest email\": first read it to get its real id, then delete by THAT id.)",
      "- NEVER ask the user for an internal id (page id, issue id, event id, parent id, UUID) — users don't know them and shouldn't have to. Every app has search/list tools: when you need an item you don't have an id for (a parent page, a target issue, a contact), FIND IT YOURSELF by name first (e.g. search the app for \"Certus AI\"), then use the exact id from the result. If a tool demands a parent/target id, that's your cue to search — not to ask. Only if several results genuinely match, ask the user to pick BY NAME (\"the CERTUS-AI page or the Mike-Brief one?\") — never recite ids.",
      "- Never feed a tool a GUESSED value — a phone number, email, name, date, or amount the user didn't give you. If a required detail is missing, ask for that one thing first; don't make one up.",
      "- For a genuinely multi-step task, plan briefly with the update_plan tool and tick steps off as you go. Skip the plan for simple one-step requests — don't make single-step plans.",
      "- OFFLOAD HEAVY WORK: if a task will take a while or run many steps and would otherwise make the user wait in silence (organize my inbox, research a topic, draft a long document, process many items), use spawn_background_task to run it as a background sub-agent and keep talking. The sub-agent has the same tools, skills, and memory you do, and reports back when it's done. Also use it whenever the user explicitly says \"in the background\" or \"keep talking while you do it.\" Right after you start it, say one short sentence confirming it's running in the background.",
      "- FILES / SHELL / CODE → ALWAYS the background sub-agent: the background sub-agent ALSO has filesystem and terminal tools you do NOT have here — reading/writing/editing files, listing directories, grep/searching files, and running shell commands. So for ANY request that involves a file, a folder, the terminal, running a command, grepping/searching files, or writing/editing code, you MUST use spawn_background_task (it can do it). NEVER tell the user you 'can't create files', 'don't have filesystem/shell access', or 'can only use connected services' — that's wrong; hand the work to the sub-agent and confirm it's running.",
      "- CHECK-INS: when the user asks how a task is going (\"how's that going?\", \"is it done?\", \"what's it doing?\"), call background_tasks and tell them in plain, human language what the sub-agent is doing or what it found — don't read raw status back.",
      "- Be persistent: if a tool call fails or comes back empty, try ONE different tool, query, or source before giving up — then say what you actually checked (\"I looked in X and Y\"), not a vague \"I couldn't find it.\"",
      "- Do what the user asked and NOTHING more — don't take extra actions or cause side effects they didn't ask for, and never surprise them with an action taken on their behalf.",
      "- If something looks off — a result you didn't expect, data or state you didn't set up — STOP and check with the user rather than pushing ahead on a wrong assumption.",
      "- Once you have what you need to answer, stop calling tools and respond. Don't keep digging after you've got it.",
      "- If a request is ambiguous or missing a required detail, ask ONE short clarifying question instead of guessing. Otherwise don't ask — just do it.",
      "- Confirm out loud BEFORE anything destructive or irreversible: deleting data, sending messages, spending money, or changing config. Describe what you're about to do in one line and wait for a yes — then actually do it.",
      "- Never announce a result before the tool returns it: don't say something is sent, booked, scheduled, or done until the tool has actually come back successful. If a tool genuinely fails, say so plainly and offer the next step — never invent a result or pretend an action succeeded.",
      "- GROUND EVERY WORD IN THIS TURN'S RESULTS: state a specific detail (a sender, subject, name, count, date, status, amount) only if a tool returned it THIS turn, and say an action is done only if a tool call for THAT exact action came back successful. When you describe an item, read it off the tool result — never reconstruct it from memory or from earlier in the chat. Claiming something happened when the results don't show it is the single worst mistake you can make.",
      "- " + memoryNote,
    ]

    // Full prompt (smart/deep/vision): header + character + standing orders + talk + act rules.
    const system = [
      ...header,
      ...characterRules,
      "",
      "## Active standing orders",
      orders || "(none)",
      "",
      ...talkRules,
      "",
      ...actRules,
    ].join("\n")

    // Slim prompt (fast): no tools on this turn, so the acting/tool rules are
    // noise that just confuse a tool-less reply. Keep persona + character + voice rules.
    const fastSystem = [
      ...header,
      ...characterRules,
      "",
      ...talkRules,
      "",
      "## This turn",
      "This is a quick conversational reply — just respond naturally; you have no tools on this turn. " + memoryNote,
    ].join("\n")

    this.cachedPrefix = {
      system,
      fastSystem,
      tools: [...introTools, ...skills, ...actionTools],
      cacheKey: `s${Date.now()}`,
    }
    return this.cachedPrefix
  }

  invalidatePrefix(): void {
    this.cachedPrefix = undefined
  }

  async buildTurnDelta(opts: { utterance: string; conversationId?: string }): Promise<TurnDelta> {
    const [recent, hits] = await Promise.all([
      // recentTurns is per-conversation: only the foreground has a conversationId.
      // A background sub-agent has none — it still gets goal-keyed memory below.
      opts.conversationId
        ? (this.deps.conversationStore?.recentTurns(opts.conversationId, 3) ?? Promise.resolve([]))
        : Promise.resolve([]),
      // PRE-RETRIEVAL GATE: greetings/acks recall nothing useful — skip the lookup entirely
      // (free latency win, and irrelevant memory in the window measurably hurts reasoning).
      // include_l4: skills are already surfaced as tools in the session prefix,
      // so we keep L4 OUT of the per-turn memory delta to avoid duplication and
      // token bloat. L2 (episodic) + L3 (semantic facts) are the per-turn recall.
      // Keyed on the UTTERANCE/GOAL — works with or without a conversationId.
      needsMemoryRecall(opts.utterance)
        ? (this.deps.memoryInjector?.inject(opts.utterance, { max_l2: 3, max_l3: 5, include_l4: false }) ?? Promise.resolve([]))
        : Promise.resolve([]),
    ])
    // SELF-POISONING GUARD: KAIROS's own failure narratives get memorized from past replies
    // ("KAIROS replied: I'm having trouble retrieving…") and then FTS-recalled by the very
    // question they failed on — the model parrots its own past failure instead of trying
    // (learned helplessness, 2026-06-10: 8 such rows made the Notion read permanently
    // "impossible"). A past failure is never a fact about the world — drop those hits.
    return {
      recentTurns: recent,
      memoryHits: hits
        .filter((h) => !isSelfEchoMemory(h.text))
        .map((h) => ({ ...h, text: stripSelfEcho(h.text) }))
        .filter((h) => h.text.length > 0),
      utterance: opts.utterance,
    }
  }

  async build(opts: { utterance: string; tier: Tier; conversationId?: string }): Promise<{ system: string; tools: ToolDef[] }> {
    const prefix = await this.buildSessionPrefix()
    // Fast tier has no tools → use the slim prompt (persona + voice rules only).
    const base = opts.tier === "fast" ? prefix.fastSystem : prefix.system
    // Fetch volatile per-turn context FRESH (not from the cached prefix), so live
    // persona hints (in-focus, prefer-terse) AND goal-keyed memory adapt every turn.
    // This runs WITH OR WITHOUT a conversationId so a background sub-agent gets the
    // same fresh memory layer the foreground does (it just lacks recentTurns).
    const [delta, live, apps] = await Promise.all([
      this.buildTurnDelta({ utterance: opts.utterance, conversationId: opts.conversationId }),
      this.deps.loaders.liveContext?.() ?? Promise.resolve(""),
      this.deps.loaders.connectedApps?.() ?? Promise.resolve(undefined as string[] | undefined),
    ])
    const deltaText = renderDelta(delta)
    // Current date/time, injected FRESH every turn (never cached — it changes, and a
    // stale/absent date makes "tomorrow"/"next week" resolve to a guessed date. That's
    // exactly how a "what's on my calendar tomorrow" query ended up asking Google for
    // Jan 2025). The model computes any ISO timestamps a tool needs from this.
    const nowBlock = currentDateTimeLine()
      + (apps !== undefined ? "\n" + connectedAppsLine(apps) : "")
      + (live ? "\n" + live : "")
    return {
      system: base + "\n\n## Right now\n" + nowBlock + (deltaText ? "\n\n## Current context\n" + deltaText : ""),
      tools: prefix.tools,
    }
  }
}

// Pretty names for common toolkit slugs (cosmetic only — capability is always dynamic).
const APP_NAMES: Record<string, string> = {
  gmail: "Gmail", googlecalendar: "Google Calendar", googledrive: "Google Drive",
  googledocs: "Google Docs", googlesheets: "Google Sheets", github: "GitHub",
  linear: "Linear", slack: "Slack", notion: "Notion", whatsapp: "WhatsApp",
  outlook: "Outlook", twitter: "X (Twitter)", youtube: "YouTube",
}
const prettyApp = (slug: string) => APP_NAMES[slug.toLowerCase()] ?? (slug.charAt(0).toUpperCase() + slug.slice(1))

/** The live connected-apps line — tells the model exactly which integrations exist (so "is X
 *  connected?" answers instantly and search_tools queries use the right app name), and that
 *  anything else is NOT connected (so it offers to connect instead of flailing). */
export function connectedAppsLine(slugs: string[]): string {
  // The public web is ALWAYS reachable (web_search/read_webpage are built in) —
  // without saying so here, "only these integrations" taught the model that
  // research requests were impossible, and it hallucinated instead (2026-06-10
  // flight-research session).
  const webLine =
    " Separately, you can ALWAYS search the public web with web_search and read pages with read_webpage " +
    "(prices, flights, news, businesses, facts) — no connection needed."
  if (slugs.length === 0) {
    return (
      "Connected apps: none yet. No external app is connected — if the user asks for email, calendar, tasks, or docs, offer to connect the app first." +
      webLine
    )
  }
  const list = slugs.map((s) => `${prettyApp(s)} (${s.toLowerCase()})`).join(", ")
  return (
    `Connected apps (the ONLY integrations available right now): ${list}. ` +
    `Anything not listed is NOT connected — offer to connect it rather than searching for its tools. ` +
    `Use these app names in search_tools queries (e.g. "notion create page", "gmail send email").` +
    webLine
  )
}

/** A spoken-and-tool-safe statement of the current local date & time. Recomputed
 *  per turn. Gives the model an absolute anchor for resolving relative dates/times
 *  and for computing ISO timestamps in tool args (calendar ranges, reminders). */
function currentDateTimeLine(): string {
  const now = new Date()
  // KAIROS_TZ pins the user's timezone (REQUIRED on a cloud/UTC daemon, where the
  // host TZ ≠ the user's and "tomorrow" would otherwise be off by a day). Unset =
  // host TZ, which is correct for a local machine. Bad TZ / small-ICU → ISO fallback.
  const tz = process.env.KAIROS_TZ?.trim()
  let stamp: string
  try {
    stamp = now.toLocaleString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short",
      ...(tz ? { timeZone: tz } : {}),
    })
  } catch {
    stamp = now.toISOString() // still a real, current anchor — never a guessed/empty date
  }
  return (
    `Today is ${stamp}. Resolve every relative date and time the user mentions ` +
    `("today", "tonight", "tomorrow", "this weekend", "next Tuesday", "in 2 hours") ` +
    `against THIS exact moment, and compute any ISO timestamps a tool needs (e.g. a ` +
    `calendar time range) from it — never guess, hardcode, or reuse an old date.`
  )
}

// ── Per-turn context quality controls ────────────────────────────────────────────
// The window is a budget: every irrelevant or oversized block lowers the model's
// effective reasoning (context rot). These keep the per-turn delta high-signal.

/** Greetings / acks / pure-courtesy turns recall nothing useful from memory. Deterministic
 *  (no LLM, ~0ms): short utterances made of conversational filler skip retrieval. */
export function needsMemoryRecall(utterance: string): boolean {
  let u = utterance.trim().toLowerCase().replace(/[.!?,]+$/g, "")
  if (!u) return false
  // Compound filler ("hey, how's it going") — strip a leading greeting/ack token first.
  u = u.replace(/^(hi|hey|hello|yo|oh|ok(ay)?|ah|so)[,!]?\s+/, "")
  const FILLER = /^(hi|hey|hello|yo|sup|what'?s up|good (morning|afternoon|evening|night)|how('?s| is) it going|how are you( doing)?|ok(ay)?|cool|nice|great|thanks?|thank you|thx|got it|sounds good|perfect|yes|yep|yeah|sure|no|nope|nah|bye|goodbye|see you|later|never ?mind|stop|cancel|hold on|one sec(ond)?)( (kairos|man|dude|buddy|there))?$/
  if (FILLER.test(u)) return false
  // Very short non-question fragments ("ok cool", "hey there") — still filler.
  if (u.split(/\s+/).length <= 2 && !u.includes("?") && FILLER.test(u.split(/\s+/)[0] ?? "")) return false
  return true
}

// A memory hit that is an echo of KAIROS'S OWN past failure/inability — never inject these
// as "relevant memory" (they read as facts and teach the model the task is impossible).
export const FAILURE_ECHO_RE =
  /\b(having trouble|trouble (getting|retrieving|accessing)|can'?t access|unable to (get|retrieve|access|find)|issue with (the )?(tool|retriev\w*)|requires a specific|not available right now|still having issues|i'?ll keep working on it|wasn'?t able to (finish|get|retrieve)|couldn'?t (get|retrieve|access|find)|don'?t have access|don'?t have (a|an|the|any) [\w` ]{0,24}tool|can'?t (directly )?(help|guide|show|point|look up|search|research)|not able to (help|guide|show|look|search)|isn'?t (cooperating|working|responding|available)|not (cooperating|working|responding) right now)\b/i

// THE GENERAL SELF-ECHO GUARD. A recalled copy of KAIROS's own past reply poisons two ways:
//   • failure echoes  → learned helplessness ("the task is impossible") — the Notion incident;
//   • PROMISE echoes  → response mimicry: asked the same question again, the model imitates its
//     own past "I've started looking into it…" and skips the tools entirely — the flight-research
//     parroting loop (2026-06-10, six live rows). A past promise is never a fact about the world.
// Substantive replies ("your next meeting is at 3pm") remain valuable memory and still pass.
// Walkthrough chatter ("teach me X", "done, I clicked Y", "okay it's open") is
// EPHEMERAL instruction, not knowledge — recalled later it scripts the WRONG lesson
// (live: a wallpaper walkthrough pointed at Appearance and waited for "Light",
// replaying the remembered dark-mode session step by step).
const WALKTHROUGH_ECHO_RE =
  /User said: "?(teach me|walk me through|guide me through|show me (how|where)|how (do|to|can) i\b|done[,.]? i clicked|okay[,.]? (i )?(clicked|opened)|now what|what'?s next)/i

export function isSelfEchoMemory(text: string): boolean {
  if (FAILURE_ECHO_RE.test(text)) return true
  if (/KAIROS replied:/i.test(text) && PROMISSORY_RE.test(text)) return true
  if (WALKTHROUGH_ECHO_RE.test(text)) return true
  return false
}

// THE GENERAL CURE for reply mimicry: recalled memory NEVER carries KAIROS's own
// replied words. Four poison flavors hit production in two days (failure echoes →
// learned helplessness; promise echoes → re-promising without working; denial echoes
// → "I can't"; SUCCESS echoes → "There it is." with no action taken). Regexes can't
// keep up with phrasing. So at INJECTION time the assistant half is stripped — the
// model recalls what the USER said, never how it replied. Durable facts from replies
// still flow: the consolidator distills FULL records into L3 facts off-line.
export function stripSelfEcho(text: string): string {
  return text.replace(/\s*KAIROS replied:[\s\S]*$/i, "").trim()
}

const HIT_MAX_CHARS = 300        // one memory hit never dominates the delta
const TURN_MAX_CHARS = 400       // one recent turn never dominates the delta
const DELTA_BUDGET_CHARS = 2600  // the whole per-turn delta stays a small fraction of the window

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…"
}

/** "3d ago" / "2h ago" age annotation — recency is a relevance signal the model can use.
 *  Exported for the recall_memory tool so JIT recall renders ages identically. */
export function age(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return ""
  const ms = Date.now() - ts
  if (ms < 0 || ms > 365 * 86400_000) return ""
  const d = Math.floor(ms / 86400_000)
  if (d >= 1) return ` · ${d}d ago`
  const h = Math.floor(ms / 3600_000)
  return h >= 1 ? ` · ${h}h ago` : " · just now"
}

function renderDelta(d: TurnDelta): string {
  const lines: string[] = []
  let budget = DELTA_BUDGET_CHARS
  const push = (line: string): boolean => {
    if (line.length > budget) return false
    lines.push(line); budget -= line.length
    return true
  }
  if (d.recentTurns.length > 0) {
    push("### Recent conversation")
    for (const t of d.recentTurns) { if (!push(clip(`${t.role}: ${t.text}`, TURN_MAX_CHARS))) break }
  }
  if (d.memoryHits.length > 0) {
    push("\n### Relevant memory (recalled for this request — may be stale; live data still needs a tool)")
    for (const h of d.memoryHits) { if (!push(clip(`[${h.source}${age(h.ts)}] ${h.text}`, HIT_MAX_CHARS))) break }
  }
  return lines.join("\n")
}

// Keep ContextBuilderStub as a named export so daemon (index.ts) still
// compiles until Task 3.4 swaps it for the real ContextBuilder.
export class ContextBuilderStub {
  async build(_input: { utterance: string; tier: Tier }): Promise<{ system: string; tools: ToolDef[] }> {
    return {
      system: "You are KAIROS, a proactive AI co-worker. Respond conversationally, plain text only, 1-2 sentences typical.",
      tools: [],
    }
  }
}

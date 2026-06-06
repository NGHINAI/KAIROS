// src/daemon/agents/contextBuilder.ts
// Layered system-prompt assembly with session-level prefix caching (Hermes pattern).

import type { ToolDef, Tier } from "./types"

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
      // include_l4: skills are already surfaced as tools in the session prefix,
      // so we keep L4 OUT of the per-turn memory delta to avoid duplication and
      // token bloat. L2 (episodic) + L3 (semantic facts) are the per-turn recall.
      // Keyed on the UTTERANCE/GOAL — works with or without a conversationId.
      this.deps.memoryInjector?.inject(opts.utterance, { max_l2: 3, max_l3: 5, include_l4: false }) ?? Promise.resolve([]),
    ])
    return { recentTurns: recent, memoryHits: hits, utterance: opts.utterance }
  }

  async build(opts: { utterance: string; tier: Tier; conversationId?: string }): Promise<{ system: string; tools: ToolDef[] }> {
    const prefix = await this.buildSessionPrefix()
    // Fast tier has no tools → use the slim prompt (persona + voice rules only).
    const base = opts.tier === "fast" ? prefix.fastSystem : prefix.system
    // Fetch volatile per-turn context FRESH (not from the cached prefix), so live
    // persona hints (in-focus, prefer-terse) AND goal-keyed memory adapt every turn.
    // This runs WITH OR WITHOUT a conversationId so a background sub-agent gets the
    // same fresh memory layer the foreground does (it just lacks recentTurns).
    const [delta, live] = await Promise.all([
      this.buildTurnDelta({ utterance: opts.utterance, conversationId: opts.conversationId }),
      this.deps.loaders.liveContext?.() ?? Promise.resolve(""),
    ])
    const deltaText = renderDelta(delta)
    // Current date/time, injected FRESH every turn (never cached — it changes, and a
    // stale/absent date makes "tomorrow"/"next week" resolve to a guessed date. That's
    // exactly how a "what's on my calendar tomorrow" query ended up asking Google for
    // Jan 2025). The model computes any ISO timestamps a tool needs from this.
    const nowBlock = currentDateTimeLine() + (live ? "\n" + live : "")
    return {
      system: base + "\n\n## Right now\n" + nowBlock + (deltaText ? "\n\n## Current context\n" + deltaText : ""),
      tools: prefix.tools,
    }
  }
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

function renderDelta(d: TurnDelta): string {
  const lines: string[] = []
  if (d.recentTurns.length > 0) {
    lines.push("### Recent conversation")
    for (const t of d.recentTurns) lines.push(`${t.role}: ${t.text}`)
  }
  if (d.memoryHits.length > 0) {
    lines.push("\n### Relevant memory")
    for (const h of d.memoryHits) lines.push(`[${h.source}] ${h.text}`)
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

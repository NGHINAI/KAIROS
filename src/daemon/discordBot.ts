// Discord bot — real-time bidirectional communication via Gateway WebSocket.
//
// The webhook handles outbound (POST messages to channel).
// This module handles INBOUND: opens a persistent WebSocket connection to
// Discord's Gateway, receives MESSAGE_CREATE events in real-time (~ms latency),
// parses them as KAIROS commands, routes to the right handler.

import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import * as queries from './db'
import { log, logError } from './logger'
import { postToDiscord } from './discord'

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

// Intents bitmask: GUILDS (1) | GUILD_MESSAGES (512) | MESSAGE_CONTENT (32768)
const INTENTS = 1 | (1 << 9) | (1 << 15)

// Discord Gateway opcodes
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

type DiscordAttachment = {
  id: string
  filename: string
  url: string         // Discord CDN URL
  proxy_url?: string
  content_type?: string  // e.g. 'image/png'
  size?: number
}

type DiscordMessage = {
  id: string
  content: string
  channel_id: string
  author: {
    id: string
    username: string
    bot?: boolean
  }
  attachments?: DiscordAttachment[]
}

type BotConfig = {
  botToken: string
  channelId: string
  sandboxDir: string
}

export class DiscordBot {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private heartbeatInterval = 41_250 // default until Hello arrives
  private lastSequence: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string | null = null
  private botUserId: string | null = null
  private botUsername: string | null = null
  private reconnectAttempts = 0
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private history: import('./discordHistory').DiscordHistory | null = null
  private summarizationTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private config: BotConfig,
    private db: Database,
    private triggerTick: (event: { source: string; reason: string }) => void,
  ) {
    // Lazy-init history on first use to avoid circular deps
    void import('./discordHistory').then(({ DiscordHistory }) => {
      this.history = new DiscordHistory(this.db, { sandboxDir: this.config.sandboxDir } as never)
      // Periodic summarization every 10 minutes
      this.summarizationTimer = setInterval(() => {
        if (this.history) void this.history.maybeSummarize(this.config.channelId)
      }, 10 * 60_000)
    })
  }

  /**
   * Open the gateway connection. Returns once the WebSocket is opened —
   * full READY happens asynchronously.
   */
  async start(): Promise<void> {
    this.stopped = false
    await this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.cleanupWs()
  }

  private cleanupWs(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.ws) {
      try {
        this.ws.close(1000)
      } catch {
        // already closed
      }
      this.ws = null
    }
  }

  private async connect(): Promise<void> {
    const url = this.resumeUrl ?? GATEWAY_URL

    log(`Discord gateway connecting to ${url.split('?')[0]}...`)

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      logError('Discord gateway connection failed', err)
      this.scheduleReconnect()
      return
    }

    this.ws.onopen = () => {
      log('Discord gateway WebSocket open')
      this.reconnectAttempts = 0
    }

    this.ws.onmessage = (event) => {
      void this.handleGatewayMessage(event.data as string)
    }

    this.ws.onclose = (event) => {
      log(`Discord gateway closed (code ${event.code}, reason: ${event.reason || 'none'})`)
      this.cleanupWs()
      if (!this.stopped) this.scheduleReconnect()
    }

    this.ws.onerror = (err) => {
      logError('Discord gateway WebSocket error', err)
      // onclose will fire after onerror; reconnect logic is there
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectAttempts++
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts - 1),
      RECONNECT_MAX_MS,
    )
    log(`Discord gateway reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private async handleGatewayMessage(data: string): Promise<void> {
    let payload: { op: number; d?: any; s?: number; t?: string }
    try {
      payload = JSON.parse(data)
    } catch {
      logError('Discord gateway: invalid JSON payload')
      return
    }

    if (payload.s !== undefined && payload.s !== null) {
      this.lastSequence = payload.s
    }

    switch (payload.op) {
      case OP_HELLO: {
        // Server tells us how often to heartbeat
        this.heartbeatInterval = (payload.d?.heartbeat_interval as number) ?? 41250
        this.startHeartbeat()
        // Try resume if we have a session, otherwise identify fresh
        if (this.sessionId && this.resumeUrl) {
          this.send({
            op: OP_RESUME,
            d: {
              token: this.config.botToken,
              session_id: this.sessionId,
              seq: this.lastSequence,
            },
          })
        } else {
          this.send({
            op: OP_IDENTIFY,
            d: {
              token: this.config.botToken,
              intents: INTENTS,
              properties: {
                os: process.platform,
                browser: 'kairos',
                device: 'kairos-daemon',
              },
            },
          })
        }
        break
      }

      case OP_HEARTBEAT:
        // Server requested a heartbeat right now
        this.sendHeartbeat()
        break

      case OP_HEARTBEAT_ACK:
        // Heartbeat confirmed
        break

      case OP_RECONNECT:
        // Server says we should reconnect (and try to resume)
        log('Discord gateway: server requested reconnect')
        this.cleanupWs()
        this.scheduleReconnect()
        break

      case OP_INVALID_SESSION:
        // Resume failed; full re-identify
        log('Discord gateway: session invalid, re-identifying', 'warn')
        this.sessionId = null
        this.resumeUrl = null
        this.lastSequence = null
        // Wait a bit before re-identifying (Discord recommendation)
        setTimeout(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            this.send({
              op: OP_IDENTIFY,
              d: {
                token: this.config.botToken,
                intents: INTENTS,
                properties: { os: process.platform, browser: 'kairos', device: 'kairos-daemon' },
              },
            })
          }
        }, 1000 + Math.random() * 4000)
        break

      case OP_DISPATCH:
        await this.handleDispatch(payload.t!, payload.d)
        break

      default:
        // Unknown opcode — ignore
        break
    }
  }

  private async handleDispatch(eventType: string, data: any): Promise<void> {
    switch (eventType) {
      case 'READY': {
        this.botUserId = data.user.id
        this.botUsername = data.user.username
        this.sessionId = data.session_id
        this.resumeUrl = data.resume_gateway_url
        log(`Discord bot connected as @${this.botUsername} (id ${this.botUserId})`)
        break
      }

      case 'RESUMED': {
        log(`Discord bot session resumed`)
        break
      }

      case 'MESSAGE_CREATE': {
        const msg = data as DiscordMessage
        // Only react to messages in our configured channel
        if (msg.channel_id !== this.config.channelId) return
        // Ignore messages from KAIROS itself or any bot
        if (msg.author.bot) return
        if (msg.author.id === this.botUserId) return

        // Diagnostic: log the FULL message structure when attachments are involved.
        // If attachments are missing despite a file being uploaded, the issue is
        // upstream (Discord intent / gateway payload). If they're present here but
        // not in handleUserMessage, the issue is downstream.
        if ((data.attachments && data.attachments.length > 0) || msg.content === '') {
          const attCount = data.attachments?.length ?? 0
          const attSummary = (data.attachments ?? []).map((a: any) =>
            `${a.filename}(${a.content_type ?? 'no-type'},${a.size ?? '?'}b)`
          ).join(', ') || 'none'
          log(`Discord MESSAGE_CREATE: text="${(msg.content ?? '').slice(0, 50)}" attachments=${attCount} [${attSummary}]`)
        }

        await this.handleUserMessage(msg)
        break
      }

      default:
        // Ignore other event types (PRESENCE_UPDATE, GUILD_CREATE, etc.)
        break
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    // Discord docs recommend jittering the first heartbeat
    const jitter = Math.random()
    setTimeout(() => {
      this.sendHeartbeat()
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat()
      }, this.heartbeatInterval)
    }, this.heartbeatInterval * jitter)
  }

  private sendHeartbeat(): void {
    this.send({ op: OP_HEARTBEAT, d: this.lastSequence })
  }

  private send(payload: object): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return
    try {
      this.ws.send(JSON.stringify(payload))
    } catch (err) {
      logError('Discord gateway send failed', err)
    }
  }

  // ─── Command handling (same as before) ─────────────────────────────

  private async handleUserMessage(msg: DiscordMessage): Promise<void> {
    const text = msg.content.trim()
    const hasImages = msg.attachments?.some(a => (a.content_type ?? '').startsWith('image/')) ?? false
    if (!text && !hasImages) return

    log(`Discord ← @${msg.author.username}: "${text.slice(0, 80)}"${hasImages ? ' [+image]' : ''}`)

    // Fast paths for slash-style commands — instant response, no LLM cost.
    // Anything else goes through the agent.
    const lower = text.toLowerCase().trim()
    if (lower === 'help' || lower === '/help' || lower === '?') {
      await this.replyHelp()
      return
    }

    // Everything else → agent. The agent decides:
    //   - what to reply
    //   - whether to create tasks, schedules, investigations
    //   - whether to act on observations or approve/deny things
    //   - whether to show state (status, inbox, tasks, history)
    try {
      await this.runAgent(msg)
    } catch (err) {
      logError(`Discord agent failed for "${text.slice(0, 50)}"`, err)
      await this.reply('My agent loop crashed. Check daemon logs.')
    }
  }

  /**
   * The Discord agent: every message goes through this.
   * Spawns Haiku with current context + user message, parses structured
   * output, dispatches actions (reply, tasks, schedules, etc.).
   */
  private async runAgent(msg: DiscordMessage): Promise<void> {
    const text = msg.content.trim()
    const user = msg.author.username
    const channelId = msg.channel_id

    // Detect image attachments — KAIROS can analyze them via vision
    const imageAttachments = (msg.attachments ?? []).filter(a =>
      (a.content_type ?? '').startsWith('image/')
    )

    // Log incoming user message to history (note any images)
    const logContent = imageAttachments.length > 0
      ? `${text}\n[attached ${imageAttachments.length} image(s): ${imageAttachments.map(a => a.filename).join(', ')}]`
      : text
    if (this.history) {
      this.history.logUserMessage({
        channelId,
        messageId: msg.id,
        username: user,
        content: logContent,
      })
    }

    // FAST PATH: image attached + minimal/no text → auto-analyze
    if (imageAttachments.length > 0 && text.length < 100) {
      await this.handleImageMessage(imageAttachments, text || 'What is this image showing?', user, channelId)
      return
    }

    // Build context the agent needs to make good decisions
    const summary = queries.getDaemonSummary(this.db)
    const recentTasks = queries.getAllTasks(this.db, 5)
    const recentObservations = queries.getActiveObservations(this.db, 5)
    const unreadMessages = queries.getUnreadMessages(this.db, 'all', 5)
    const cwd = this.getActiveCwd()

    // Get conversation history (pinned + summarized + recent verbatim)
    const conversationContext = this.history
      ? this.history.buildContextBlock(channelId)
      : '(history module not loaded yet)'

    // Get available skills for the agent's awareness
    const skillRegistry = (globalThis as { __kairosSkillRegistry?: import('./skillRegistry').SkillRegistry }).__kairosSkillRegistry
    const skillsList = skillRegistry ? skillRegistry.describeForPrompt() : '(no registry)'

    const prompt = this.buildAgentPrompt({
      userMessage: logContent,
      username: user,
      summary,
      recentTasks,
      recentObservations,
      unreadMessages,
      cwd,
      conversationContext,
      skillsList,
    })

    // Spawn Haiku — cheap, fast (~$0.0003, 1-2s)
    const proc = Bun.spawn(['claude', '-p', '--model', 'claude-haiku-4-5', '--output-format', 'json'], {
      stdin: new Blob([prompt]),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = await new Response(proc.stdout).text()
    await proc.exited

    let raw = ''
    try {
      const parsed = JSON.parse(stdout) as { result?: string }
      raw = (parsed.result ?? '').trim()
    } catch {
      raw = stdout.trim()
    }

    if (!raw) {
      await this.reply('(agent returned nothing)')
      return
    }

    // Parse action blocks: [VERB: payload]
    const actions = this.extractActions(raw)
    const replyText = this.stripActions(raw).trim()

    // Always reply with the natural-language portion (if any)
    if (replyText) {
      await this.reply(replyText)
    }

    // Log the assistant reply with its actions
    if (this.history) {
      this.history.logAssistantReply({
        channelId,
        content: replyText,
        actions,
      })
    }

    // Detect "I can't do that" replies → log as skill gap (L3 signal)
    if (actions.length === 0 && this.detectsDecline(replyText) && this.detectsCapabilityRequest(text)) {
      this.recordDeclineAsGap(text, replyText)
    }

    // Dispatch each action block in order
    for (const action of actions) {
      await this.dispatchAction(action, user, cwd)
    }

    log(`Discord agent → reply (${replyText.length} chars) + ${actions.length} action(s)`)
  }

  /**
   * Heuristic: did the agent decline to do something?
   * Catches phrases like "I can't", "no, but", "not yet", "not natively", etc.
   */
  private detectsDecline(reply: string): boolean {
    const r = reply.toLowerCase()
    return /\b(can't|cannot|not yet|not natively|don't have|no(?:t)? (?:able|capable))\b/i.test(r)
        || /\b(would need|you'd need|i'd need|i could if)\b/i.test(r)
  }

  /**
   * Heuristic: was the user asking about a capability (vs. just chatting)?
   */
  private detectsCapabilityRequest(userText: string): boolean {
    const t = userText.toLowerCase()
    return /\b(can you|could you|do you|are you able|please|monitor|check|track|watch|fetch|get|read|send|post|deploy)\b/i.test(t)
  }

  /**
   * Log a declined capability as a gap so it surfaces in dream consolidation.
   */
  private recordDeclineAsGap(userText: string, kairosReply: string): void {
    try {
      const detector = (globalThis as { __kairosSkillGapDetector?: import('./skillGapDetector').SkillGapDetector }).__kairosSkillGapDetector
      if (!detector) return
      // Categorize from text content
      const lc = userText.toLowerCase()
      let category = 'general'
      const domains: Record<string, string[]> = {
        email: ['email', 'gmail', 'mail', 'inbox'],
        slack: ['slack'],
        discord: ['discord channel', 'discord server'],
        calendar: ['calendar', 'meeting', 'event'],
        browser: ['browser', 'tab', 'page', 'website'],
        notion: ['notion'],
        roam: ['roam'],
        api: ['api', 'webhook', 'endpoint'],
        cloud: ['aws', 'gcp', 'azure', 'cloud'],
      }
      for (const [cat, kws] of Object.entries(domains)) {
        if (kws.some(k => lc.includes(k))) { category = cat; break }
      }
      detector.recordGap({
        category,
        pattern: `discord_decline:${userText.slice(0, 80).toLowerCase()}`,
        description: `User asked: "${userText.slice(0, 100)}". KAIROS declined: "${kairosReply.slice(0, 100)}". Worth proposing a skill?`,
      })
      log(`Logged Discord decline as gap [${category}]`)
    } catch (err) {
      logError('Failed to log decline as gap', err)
    }
  }

  private buildAgentPrompt(ctx: {
    userMessage: string
    username: string
    summary: ReturnType<typeof queries.getDaemonSummary>
    recentTasks: ReturnType<typeof queries.getAllTasks>
    recentObservations: ReturnType<typeof queries.getActiveObservations>
    unreadMessages: ReturnType<typeof queries.getUnreadMessages>
    cwd: string
    conversationContext?: string
    skillsList?: string
  }): string {
    const tasksList = ctx.recentTasks.length === 0
      ? '(none)'
      : ctx.recentTasks.map(t => `  • ${t.task_id} [${t.status}] ${t.description.slice(0, 80)}`).join('\n')

    const obsList = ctx.recentObservations.length === 0
      ? '(none)'
      : ctx.recentObservations.map(o => `  • ${o.observation_id} [${o.severity}] ${o.description.slice(0, 80)}`).join('\n')

    const inboxList = ctx.unreadMessages.length === 0
      ? '(empty)'
      : ctx.unreadMessages.map(m => `  • [${m.kind}] ${m.body.slice(0, 100)}`).join('\n')

    return `You are KAIROS, an always-on autonomous AI assistant. The user (@${ctx.username}) just sent you a message in your Discord channel. Decide what to do.

# Conversation history

${ctx.conversationContext ?? '(none)'}

# Available skills

${ctx.skillsList ?? '(no custom skills loaded)'}

# Current state

Daemon: running. ${ctx.summary.tickCount} ticks. ${ctx.summary.connectedClients} clients connected.
Active sandbox dir: ${ctx.cwd}
Queue: ${ctx.summary.queueDepth} tasks queued, ${ctx.summary.runningCount} running.
Pending approvals: ${ctx.summary.pendingApprovals}.

Recent tasks:
${tasksList}

Active observations:
${obsList}

Unread messages in inbox:
${inboxList}

# Current user message

"${ctx.userMessage}"

# Your job — be agentic, not passive

Reply naturally in your voice (witty, slightly sardonic, never corporate, no "certainly"/"of course"/"absolutely"). 1-3 sentences.

Use the conversation history above to resolve references like "the first one", "do that again", "yes", or anything that depends on prior context.

**CRITICAL — when asked about a capability you don't yet have:**

- DO NOT say "I can't" and stop there.
- INSTEAD: figure out what skill would solve it. If it can be a bash script, propose it via [GENERATE_SKILL: ...]. If it requires user-supplied credentials (OAuth, API keys), explain what you need + propose generating the skill once you have them.
- True limits exist (you can't sign up for Gmail accounts via CAPTCHA, you can't operate a browser UI). Be honest about those. But for everything else, REACH FOR GENERATE_SKILL.

If the user is asking you to DO something, include action block(s) in your reply. Action blocks are removed before posting to Discord — they're parsed and dispatched.

Available actions:

[CREATE_TASK: <description>]
   Spawn a real work task. Use for non-trivial things you need to actually do.
   Example: [CREATE_TASK: Check the Pulse bot status — query trades, P&L, capital, process health, and report back.]

[SCHEDULE: <description> | when: <when>]
   Create a recurring or one-shot scheduled task.
   Example: [SCHEDULE: Check Pulse bot status | when: every 30 minutes]
   Example: [SCHEDULE: Run the test suite | when: every weekday at 9am]

[INVESTIGATE: <topic>]
   Quick read-only exploration. Use for questions you can answer by checking files/git/etc.
   Example: [INVESTIGATE: what tests are currently failing in the dashboard repo]

[APPROVE: <approval_id>] / [DENY: <approval_id>]
   Approve or deny a pending command approval (only if pending_approvals > 0).

[ACT: <observation_id>] / [DISMISS: <observation_id>]
   Act on or dismiss an active observation.

[SHOW: status|inbox|tasks|skills|gaps|prompts|patches]
   Post a formatted state embed back to Discord.

# Self-evolution actions (L1-L5)

[INVOKE_SKILL: <skill_name>]
[INVOKE_SKILL: <skill_name> | args: <space-separated args>]
   Run an existing skill from the registry. Use this when the user asks something a custom skill can answer (disk, system stats, git activity, custom queries, etc).
   Example: [INVOKE_SKILL: disk-space]
   Example: [INVOKE_SKILL: recent-git-activity | args: /Users/nirmal/Desktop/myproj]

[GENERATE_SKILL: <description>]
   You don't have a skill for what's being asked? **Write one.** This is your most powerful tool. Be bold — if a bash script could plausibly do it, propose generating one. The script gets validated before activation, so a bad attempt won't break anything.
   Example: [GENERATE_SKILL: count number of open Chrome tabs and return as JSON]
   Example: [GENERATE_SKILL: query postgres at localhost:5432 for active connection count using PGPASSWORD env var]
   Example: [GENERATE_SKILL: poll IMAP server using GMAIL_USER and GMAIL_APP_PASSWORD env vars, return new message subjects as JSON]

[FILL_GAP: <gap_id>]
   User accepted a gap suggestion — KAIROS auto-generates a skill for it.

[DISMISS_GAP: <gap_id>]
   User said no, ignore this gap forever.

[EXPERIMENT_PROMPT: <prompt_name> | content: <new prompt text>]
   Create an experimental version of a prompt to A/B test. Production version stays untouched.

[PROMOTE_PROMPT: <prompt_name> | version: <vN-experiment>]
   Make an experimental prompt the active one (manual promote, no metrics required).

[PROPOSE_PATCH: <file_path> | reason: <why>]
   Propose a source-code change to KAIROS itself. Restricted to src/daemon/ and src/shim/. Requires user APPROVE_PATCH before applying.
   Example: [PROPOSE_PATCH: src/daemon/scheduler.ts | reason: increase tick coalescing buffer from 3 to 5]

   File routing — pick the RIGHT file for the area being fixed:
   - src/daemon/discordBot.ts  → bot inbound (gateway, message handling, attachments, image detection, agent loop)
   - src/daemon/discord.ts     → outbound webhook only (DO NOT touch for incoming-message bugs)
   - src/daemon/discordHistory.ts → conversation history / summarization
   - src/daemon/scheduler.ts   → tick loop, decision dispatch
   - src/daemon/decisionEngine.ts → LLM decision parsing
   - src/daemon/taskRunner.ts  → claude -p subprocess for tasks
   - src/daemon/skillRegistry.ts / skillGenerator.ts / skillGapDetector.ts → skills (L1-L3)
   - src/daemon/promptEvolution.ts → A/B prompts (L4)
   - src/daemon/sourceEvolution.ts → patch lifecycle (L5)
   - src/daemon/selfDebugger.ts → log scanning, error pattern detection
   - src/daemon/multimodal.ts  → image/audio analysis
   - src/daemon/memory.ts      → MEMORY.md + dream consolidation
   When in doubt about which file owns the bug, INVESTIGATE first to confirm.

[APPROVE_PATCH: <patch_id>] / [REJECT_PATCH: <patch_id>]
   Apply or reject a previously-proposed source patch.

[ANALYZE_IMAGE: <image_url> | prompt: <what to look for>]
   Analyze an image via vision. Use when the user references an image URL
   they want explained (screenshots, charts, photos, error messages, UI mockups).
   For Discord image attachments: KAIROS auto-analyzes those without needing
   this verb — but you can use it for URLs found in the conversation.
   Example: [ANALYZE_IMAGE: https://i.imgur.com/abc.png | prompt: identify the error in this screenshot]

# Examples

User: "hey"
You: Hey. Anything you need?

User: "check pulse bot"
You: On it.
[CREATE_TASK: Check Pulse bot status — query trades, P&L, win rate, capital, and process health.]

User: "every hour, run tests"
You: Got it. Scheduled.
[SCHEDULE: Run the test suite and report any failures | when: every hour]

User: "what's failing"
You: Let me look.
[INVESTIGATE: what tests or builds are currently failing across the active project]

User: "thanks"
You: Anytime.

User: "approve a_42"
You: Approving.
[APPROVE: a_42]

User: "how much disk space"
You: Checking.
[INVOKE_SKILL: disk-space]

User: "what skills do you have"
You: Here's what I can do.
[SHOW: skills]

User: "write me a skill that lists open ports"
You: On it — generating now.
[GENERATE_SKILL: list all listening TCP ports and the processes bound to them, return JSON]

User: "what gaps have you noticed"
You: Looking.
[SHOW: gaps]

User: "fill gap_xyz"
You: Generating a skill for that.
[FILL_GAP: gap_xyz]

User: "any patches pending"
You: Let me check.
[SHOW: patches]

User: "approve patch_abc"
You: Applying.
[APPROVE_PATCH: patch_abc]

# Output

Reply naturally. Add action blocks ONLY if you actually need to do work.
Action blocks come AFTER your text reply, on their own lines.
Do NOT explain that you're using action blocks — just use them.`
  }

  private extractActions(text: string): Array<{ verb: string; payload: string }> {
    const actions: Array<{ verb: string; payload: string }> = []
    // Matches both [VERB: payload] and [VERB] (no payload — for actions like LIST_SKILLS)
    const regex = /\[(CREATE_TASK|SCHEDULE|INVESTIGATE|APPROVE|DENY|ACT|DISMISS|SHOW|INVOKE_SKILL|GENERATE_SKILL|FILL_GAP|DISMISS_GAP|EXPERIMENT_PROMPT|PROMOTE_PROMPT|PROPOSE_PATCH|APPROVE_PATCH|REJECT_PATCH|ANALYZE_IMAGE)(?:\s*:\s*([^\]]+))?\]/g
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      actions.push({ verb: match[1]!.trim(), payload: (match[2] ?? '').trim() })
    }
    return actions
  }

  private stripActions(text: string): string {
    return text.replace(
      /\[(CREATE_TASK|SCHEDULE|INVESTIGATE|APPROVE|DENY|ACT|DISMISS|SHOW|INVOKE_SKILL|GENERATE_SKILL|FILL_GAP|DISMISS_GAP|EXPERIMENT_PROMPT|PROMOTE_PROMPT|PROPOSE_PATCH|APPROVE_PATCH|REJECT_PATCH|ANALYZE_IMAGE)(?:\s*:\s*[^\]]+)?\]/g,
      '',
    ).trim()
  }

  private async dispatchAction(
    action: { verb: string; payload: string },
    user: string,
    cwd: string,
  ): Promise<void> {
    log(`Discord agent action: ${action.verb} → ${action.payload.slice(0, 60)}`)

    switch (action.verb) {
      case 'CREATE_TASK': {
        const taskId = queries.createTask(this.db, {
          description: action.payload,
          sessionId: null,
          priority: 'high',
          permissionMode: 'bypass',
          workingDir: cwd,
        })
        this.triggerTick({ source: 'new_task', reason: `Discord agent → task ${taskId}` })
        await this.reply(`✓ Task \`${taskId}\` queued.`)
        break
      }

      case 'SCHEDULE': {
        // Parse "<description> | when: <when>"
        const parts = action.payload.split(/\|\s*when\s*:\s*/i)
        if (parts.length !== 2) {
          await this.reply(`Couldn't parse schedule. Use: \`description | when: <schedule>\``)
          return
        }
        const description = parts[0]!.trim()
        const when = parts[1]!.trim()
        const { ScheduleManager } = await import('./scheduleManager')
        // Load the FULL config — the previous stub was missing schedule.maxActiveSchedules,
        // observation, feedback, models, etc., which caused crashes.
        const { loadConfig } = await import('./config')
        const fullConfig = loadConfig(this.config.sandboxDir, true, true)
        const mgr = new ScheduleManager(this.db, fullConfig)
        const result = await mgr.create({
          description,
          schedule: when,
          workingDir: cwd,
          priority: 'high',
        })
        if (result.error) {
          await this.reply(`Schedule error: ${result.error}`)
        } else {
          await this.reply(`⏰ Scheduled: \`${result.scheduleId}\` — next fire ${result.nextFireAt ? new Date(result.nextFireAt).toLocaleString() : 'unknown'}`)
          // CRITICAL: if the schedule fires within 2 minutes, set a timer to
          // wake the tick loop at the exact fire time. Without this, a "in 10s"
          // schedule would be ignored because the tick loop might be SLEEPing
          // for 30 minutes. Same fix as in server.ts kairos_schedule create.
          if (result.nextFireAt && result.nextFireAt - Date.now() < 120_000) {
            const delay = Math.max(1000, result.nextFireAt - Date.now())
            setTimeout(() => {
              this.triggerTick({
                source: 'schedule_due',
                reason: `Discord schedule ${result.scheduleId} due`,
              })
            }, delay)
          }
        }
        break
      }

      case 'INVESTIGATE': {
        // Investigation is a read-only quick task
        const taskId = queries.createTask(this.db, {
          description: `[Investigate] ${action.payload}`,
          sessionId: null,
          priority: 'normal',
          permissionMode: 'bypass',
          workingDir: cwd,
        })
        this.triggerTick({ source: 'new_task', reason: `Discord agent → investigate ${taskId}` })
        break
      }

      case 'APPROVE': {
        await this.handleApprove(action.payload, user)
        break
      }

      case 'DENY': {
        await this.handleDeny(action.payload)
        break
      }

      case 'ACT': {
        await this.handleAct(action.payload, user)
        break
      }

      case 'DISMISS': {
        await this.handleDismiss(action.payload)
        break
      }

      case 'SHOW': {
        const target = action.payload.toLowerCase().trim()
        if (target === 'status') await this.handleStatus()
        else if (target === 'inbox') await this.handleShowInbox()
        else if (target === 'tasks') await this.handleShowTasks()
        else if (target === 'skills') await this.handleShowSkills()
        else if (target === 'gaps') await this.handleShowGaps()
        else if (target === 'prompts') await this.handleShowPrompts()
        else if (target === 'patches') await this.handleShowPatches()
        else await this.reply(`Don't know how to show "${target}"`)
        break
      }

      // ─── L1: Skill plugin invocation ──────────────────────────────
      case 'INVOKE_SKILL': {
        // payload format: "<skill_name>" or "<skill_name> | args: <args>"
        const parts = action.payload.split(/\|\s*args\s*:\s*/i)
        const skillName = parts[0]!.trim()
        const argsStr = parts[1]?.trim() ?? ''
        const args = argsStr ? argsStr.split(/\s+/) : []

        const registry = (globalThis as { __kairosSkillRegistry?: import('./skillRegistry').SkillRegistry }).__kairosSkillRegistry
        if (!registry) {
          await this.reply('Skill registry not initialized.')
          break
        }
        const result = await registry.invokeSkill(skillName, args)
        if (!result.ok) {
          await this.reply(`✗ Skill \`${skillName}\` failed: ${result.error?.slice(0, 200) ?? 'unknown'}`)
        } else {
          const out = result.parsed
            ? '```json\n' + JSON.stringify(result.parsed, null, 2).slice(0, 1500) + '\n```'
            : '```\n' + result.output.slice(0, 1500) + '\n```'
          await this.reply(`🔧 \`${skillName}\` (${result.duration_ms}ms):\n${out}`)
        }
        break
      }

      // ─── L2: Self-generate a new skill ────────────────────────────
      case 'GENERATE_SKILL': {
        const generator = (globalThis as { __kairosSkillGenerator?: import('./skillGenerator').SkillGenerator }).__kairosSkillGenerator
        if (!generator) {
          await this.reply('Skill generator not initialized.')
          break
        }
        await this.reply(`✏️ Generating skill: "${action.payload.slice(0, 80)}"... (this takes ~30-60s)`)
        const result = await generator.generateSkill({
          description: action.payload,
          output_format: 'json',
          category: 'general',
        })
        if (result.ok) {
          await this.reply(`✓ Skill **${result.skill_name}** generated and active.\n` +
            `Test output: \`\`\`\n${(result.test_output ?? '').slice(0, 300)}\n\`\`\``)
        } else {
          await this.reply(`✗ Generation failed: ${result.error?.slice(0, 200)}`)
        }
        break
      }

      // ─── L3: Skill gap actions ─────────────────────────────────────
      case 'FILL_GAP': {
        const gapId = action.payload.trim()
        const detector = (globalThis as { __kairosSkillGapDetector?: import('./skillGapDetector').SkillGapDetector }).__kairosSkillGapDetector
        const generator = (globalThis as { __kairosSkillGenerator?: import('./skillGenerator').SkillGenerator }).__kairosSkillGenerator
        if (!detector || !generator) {
          await this.reply('Gap detector or generator not initialized.')
          break
        }
        const gap = (this.db.query('SELECT * FROM skill_gaps WHERE gap_id = ?').get(gapId)) as
          { gap_id: string; category: string; description: string; proposed_skill_desc: string | null } | null
        if (!gap) {
          await this.reply(`Gap \`${gapId}\` not found.`)
          break
        }
        await this.reply(`✏️ Generating skill to fill gap \`${gapId}\` [${gap.category}]...`)
        const skillDesc = gap.proposed_skill_desc ?? `Address the ${gap.category} gap: ${gap.description}`
        const result = await generator.generateSkill({
          description: skillDesc,
          category: gap.category,
          output_format: 'json',
        })
        if (result.ok) {
          detector.markActed(gapId)
          await this.reply(`✓ Skill **${result.skill_name}** generated and active. Gap filled.`)
        } else {
          await this.reply(`✗ Generation failed: ${result.error?.slice(0, 200)}`)
        }
        break
      }

      case 'DISMISS_GAP': {
        const gapId = action.payload.trim()
        const detector = (globalThis as { __kairosSkillGapDetector?: import('./skillGapDetector').SkillGapDetector }).__kairosSkillGapDetector
        if (!detector) {
          await this.reply('Gap detector not initialized.')
          break
        }
        detector.dismiss(gapId)
        await this.reply(`Gap \`${gapId}\` dismissed. I'll learn not to suggest it.`)
        break
      }

      // ─── L4: Prompt evolution ──────────────────────────────────────
      case 'EXPERIMENT_PROMPT': {
        // payload: "<prompt_name> | content: <text>"
        const parts = action.payload.split(/\|\s*content\s*:\s*/i)
        if (parts.length !== 2) {
          await this.reply('Use format: `prompt_name | content: <new prompt text>`')
          break
        }
        const promptName = parts[0]!.trim()
        const content = parts[1]!.trim()
        const evo = (globalThis as { __kairosPromptEvolution?: import('./promptEvolution').PromptEvolution }).__kairosPromptEvolution
        if (!evo) {
          await this.reply('Prompt evolution not initialized.')
          break
        }
        try {
          const version = evo.createExperiment(promptName, content, `Created via Discord by @${user}`)
          await this.reply(`🧪 Experiment created: **${promptName}/${version}**. 25% of traffic will use it. Auto-promote at +15% effectiveness over 50 samples.`)
        } catch (err) {
          await this.reply(`✗ Failed: ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }

      case 'PROMOTE_PROMPT': {
        // payload: "<prompt_name> | version: <version>" OR just "<prompt_name>/<version>"
        let promptName: string
        let version: string
        if (action.payload.includes('|')) {
          const parts = action.payload.split(/\|\s*version\s*:\s*/i)
          promptName = parts[0]!.trim()
          version = parts[1]?.trim() ?? ''
        } else {
          const parts = action.payload.split('/')
          promptName = parts[0]!.trim()
          version = parts[1]?.trim() ?? ''
        }
        const evo = (globalThis as { __kairosPromptEvolution?: import('./promptEvolution').PromptEvolution }).__kairosPromptEvolution
        if (!evo) {
          await this.reply('Prompt evolution not initialized.')
          break
        }
        try {
          evo.promote(promptName, version)
          await this.reply(`⭐ Promoted **${promptName}/${version}** to active.`)
        } catch (err) {
          await this.reply(`✗ ${err instanceof Error ? err.message : String(err)}`)
        }
        break
      }

      // ─── L5: Source self-modification ──────────────────────────────
      case 'PROPOSE_PATCH': {
        // payload: "<file_path> | reason: <reason>"
        const parts = action.payload.split(/\|\s*reason\s*:\s*/i)
        if (parts.length !== 2) {
          await this.reply('Use format: `src/daemon/file.ts | reason: <why>`')
          break
        }
        const targetFile = parts[0]!.trim()
        const reason = parts[1]!.trim()
        const evo = (globalThis as { __kairosSourceEvolution?: import('./sourceEvolution').SourceEvolution }).__kairosSourceEvolution
        if (!evo) {
          await this.reply('Source evolution not initialized.')
          break
        }
        await this.reply(`🛠️ Generating patch for \`${targetFile}\`... (~30-60s)`)
        const result = await evo.proposePatch({ targetFile, reason })
        if (result.ok) {
          await this.reply(`✓ Patch **${result.patch_id}** validated and ready. Reply with \`approve patch ${result.patch_id}\` to apply, or \`reject patch ${result.patch_id}\`.`)
        } else {
          await this.reply(`⚠️ Patch \`${result.patch_id ?? '?'}\` rejected at validation: ${result.error?.slice(0, 200)}`)
        }
        break
      }

      case 'APPROVE_PATCH': {
        const patchId = action.payload.trim()
        const evo = (globalThis as { __kairosSourceEvolution?: import('./sourceEvolution').SourceEvolution }).__kairosSourceEvolution
        if (!evo) {
          await this.reply('Source evolution not initialized.')
          break
        }
        await this.reply(`Applying patch \`${patchId}\` and rebuilding...`)
        const result = await evo.approveAndApply(patchId)
        if (result.ok) {
          await this.reply(`✓ Patch applied. Restart daemon to pick up changes:\n\`\`\`\n${(result.build_log ?? '').slice(0, 400)}\n\`\`\``)
        } else {
          await this.reply(`✗ Apply failed: ${result.error?.slice(0, 200)}`)
        }
        break
      }

      case 'REJECT_PATCH': {
        const patchId = action.payload.trim()
        const evo = (globalThis as { __kairosSourceEvolution?: import('./sourceEvolution').SourceEvolution }).__kairosSourceEvolution
        if (!evo) {
          await this.reply('Source evolution not initialized.')
          break
        }
        const ok = evo.reject(patchId, `Rejected via Discord by @${user}`)
        await this.reply(ok ? `Patch \`${patchId}\` rejected.` : `Could not reject patch \`${patchId}\` (already applied or not found).`)
        break
      }

      // ─── H: Multi-modal — analyze a referenced image ─────────────
      case 'ANALYZE_IMAGE': {
        // payload: "<url> | prompt: <what to analyze>"
        const parts = action.payload.split(/\|\s*prompt\s*:\s*/i)
        const url = parts[0]!.trim()
        const prompt = parts[1]?.trim() ?? 'Describe what you see and what is most relevant.'
        const { MultiModalAnalyzer } = await import('./multimodal')
        const analyzer = new MultiModalAnalyzer({ sandboxDir: this.config.sandboxDir, models: { work: 'claude-sonnet-4-6' } } as never)
        const result = await analyzer.analyzeImage({
          image: { source: 'url', data: url },
          prompt,
          detail: 'detailed',
        })
        if (result.ok) {
          await this.reply(`🖼️ ${result.description.slice(0, 1700)}`)
        } else {
          await this.reply(`✗ Image analysis failed: ${result.error?.slice(0, 200)}`)
        }
        break
      }

      default:
        log(`Discord agent: unknown action ${action.verb}`, 'warn')
    }
  }

  /**
   * Fast-path handler for messages where the user attached an image with little text.
   * Skip the agent loop, just analyze and reply.
   */
  private async handleImageMessage(
    attachments: DiscordAttachment[],
    prompt: string,
    user: string,
    channelId: string,
  ): Promise<void> {
    const first = attachments[0]!
    log(`Discord image analysis: "${prompt.slice(0, 60)}" (${first.filename})`)
    await this.reply(`🖼️ Looking at \`${first.filename}\`...`)

    const { MultiModalAnalyzer } = await import('./multimodal')
    const analyzer = new MultiModalAnalyzer({
      sandboxDir: this.config.sandboxDir,
      models: { work: 'claude-sonnet-4-6' },
    } as never)

    const result = await analyzer.analyzeImage({
      image: {
        source: 'url',
        data: first.url,
        mime_type: first.content_type,
      },
      prompt,
      detail: 'detailed',
    })

    if (result.ok) {
      await this.reply(result.description.slice(0, 1900))
      // Log assistant reply for history
      if (this.history) {
        this.history.logAssistantReply({
          channelId,
          content: result.description.slice(0, 500),
          actions: [{ verb: 'ANALYZE_IMAGE', payload: first.filename }],
        })
      }
    } else {
      await this.reply(`✗ Couldn't analyze the image: ${result.error?.slice(0, 200)}`)
    }
  }

  // ─── Show handlers for new SHOW targets ──────────────────────────

  private async handleShowSkills(): Promise<void> {
    const registry = (globalThis as { __kairosSkillRegistry?: import('./skillRegistry').SkillRegistry }).__kairosSkillRegistry
    if (!registry) {
      await this.reply('Skill registry not initialized.')
      return
    }
    const skills = registry.listSkills()
    if (skills.length === 0) {
      await this.reply('No skills loaded yet. Drop one in `skills/active/` or use `[GENERATE_SKILL: ...]`.')
      return
    }
    const lines = skills.map(s => {
      const gen = s.generated ? ' 🤖' : ''
      return `• \`${s.name}\`${gen} [${s.category ?? 'general'}] — ${s.description}`
    })
    await this.reply(`**Skills (${skills.length})**:\n${lines.join('\n').slice(0, 1800)}`)
  }

  private async handleShowGaps(): Promise<void> {
    const detector = (globalThis as { __kairosSkillGapDetector?: import('./skillGapDetector').SkillGapDetector }).__kairosSkillGapDetector
    if (!detector) {
      await this.reply('Gap detector not initialized.')
      return
    }
    const gaps = detector.listAll(false)
    if (gaps.length === 0) {
      await this.reply('No active gaps. Either everything works or no failed tasks worth analyzing yet.')
      return
    }
    const lines = gaps.map(g => `• \`${g.gap_id}\` [${g.category}] occ=${g.occurrences}: ${g.description.slice(0, 100)}`)
    await this.reply(`**Gaps (${gaps.length})**:\n${lines.join('\n').slice(0, 1800)}\n\n_Reply with \`fill <gap_id>\` to auto-generate a skill, or \`dismiss <gap_id>\` to ignore._`)
  }

  private async handleShowPrompts(): Promise<void> {
    const evo = (globalThis as { __kairosPromptEvolution?: import('./promptEvolution').PromptEvolution }).__kairosPromptEvolution
    if (!evo) {
      await this.reply('Prompt evolution not initialized.')
      return
    }
    const versions = evo.listVersions()
    if (versions.length === 0) {
      await this.reply('No prompt versions registered.')
      return
    }
    const lines = versions.map(v => {
      const flag = v.is_active ? '⭐' : v.is_experiment ? '🧪' : '  '
      const m = v.metrics
      const stats = m && m.total_uses > 0 ? ` (${m.total_uses} uses, ${m.effectiveness_pct}% eff)` : ''
      return `${flag} ${v.prompt_name}/${v.version}${stats}`
    })
    await this.reply(`**Prompt versions**:\n${lines.join('\n').slice(0, 1800)}`)
  }

  private async handleShowPatches(): Promise<void> {
    const evo = (globalThis as { __kairosSourceEvolution?: import('./sourceEvolution').SourceEvolution }).__kairosSourceEvolution
    if (!evo) {
      await this.reply('Source evolution not initialized.')
      return
    }
    const patches = evo.listAll(20)
    if (patches.length === 0) {
      await this.reply('No source patches yet.')
      return
    }
    const lines = patches.map(p => {
      let state = '⏳'
      if (p.applied_at) state = '✅'
      else if (p.rejected_at) state = '❌'
      else if (p.validation_status === 'compiled') state = '🟢'
      else if (p.validation_status === 'compile_failed') state = '⚠️'
      return `${state} \`${p.patch_id}\` [${p.target_file}] — ${p.reason.slice(0, 60)}`
    })
    await this.reply(`**Source patches**:\n${lines.join('\n').slice(0, 1800)}\n\n_Reply with \`approve patch <id>\` or \`reject patch <id>\`._`)
  }

  private async handleShowTasks(): Promise<void> {
    const tasks = queries.getAllTasks(this.db, 10)
    if (tasks.length === 0) {
      await this.reply('No tasks.')
      return
    }
    const lines = tasks.map(t => `• \`${t.task_id}\` [${t.status}] ${t.description.slice(0, 100)}`).join('\n')
    await postToDiscord({
      sandboxDir: this.config.sandboxDir,
      title: 'KAIROS — Tasks',
      body: lines.slice(0, 3500),
      severity: 'info',
    })
  }

  private async handleAct(observationId: string, user: string): Promise<void> {
    const obs = this.db.query(
      'SELECT * FROM observations WHERE observation_id = ?',
    ).get(observationId) as { observation_id: string; suggested_action: string; description: string; resolved_at: number | null } | null

    if (!obs) {
      await this.reply(`No observation \`${observationId}\` — maybe it was resolved already.`)
      return
    }

    const cwd = this.getActiveCwd()
    const taskId = queries.createTask(this.db, {
      description: obs.suggested_action ?? obs.description,
      sessionId: null,
      priority: 'high',
      permissionMode: 'bypass',
      workingDir: cwd,
    })

    queries.actOnObservation(this.db, observationId)
    this.triggerTick({ source: 'new_task', reason: `Discord act on ${observationId}` })

    await this.reply(`✓ On it. Task \`${taskId}\` created from observation \`${observationId}\`. (acked by @${user})`)
    log(`Discord → ACT on ${observationId} → task ${taskId}`)
  }

  private async handleDismiss(observationId: string): Promise<void> {
    queries.dismissObservation(this.db, observationId)
    await this.reply(`Dismissed \`${observationId}\`. Learning from that — I'll suggest this category less.`)
    log(`Discord → DISMISS ${observationId}`)
  }

  private async handleApprove(approvalId: string, user: string): Promise<void> {
    const approval = this.db.query(
      'SELECT * FROM approvals WHERE approval_id = ?',
    ).get(approvalId) as { approval_id: string; command: string; command_hash: string } | null

    if (!approval) {
      await this.reply(`No approval \`${approvalId}\`. Maybe expired or already handled.`)
      return
    }

    const approvedDir = join(this.config.sandboxDir, 'state', 'approved')
    const tokenPath = join(approvedDir, approval.command_hash)
    await Bun.write(tokenPath, '')

    this.db.run(
      `UPDATE approvals SET decided_at = ?, decision = 'approve', decided_by = ? WHERE approval_id = ?`,
      [Date.now(), `discord:${user}`, approvalId],
    )

    this.triggerTick({ source: 'approval_decided', reason: `Discord approve ${approvalId}` })
    await this.reply(`✓ Approved \`${approvalId}\`. The command will run on the next tick.`)
    log(`Discord → APPROVE ${approvalId} by @${user}`)
  }

  private async handleDeny(approvalId: string): Promise<void> {
    this.db.run(
      `UPDATE approvals SET decided_at = ?, decision = 'deny' WHERE approval_id = ?`,
      [Date.now(), approvalId],
    )
    this.triggerTick({ source: 'approval_decided', reason: `Discord deny ${approvalId}` })
    await this.reply(`Denied \`${approvalId}\`. Task will fail with that command blocked.`)
    log(`Discord → DENY ${approvalId}`)
  }

  private async handleStatus(): Promise<void> {
    const summary = queries.getDaemonSummary(this.db)
    await postToDiscord({
      sandboxDir: this.config.sandboxDir,
      title: 'KAIROS — Status',
      body: 'Current state snapshot.',
      severity: 'info',
      fields: [
        { name: 'Daemon', value: 'running', inline: true },
        { name: 'Ticks', value: summary.tickCount.toString(), inline: true },
        { name: 'Clients', value: summary.connectedClients.toString(), inline: true },
        { name: 'Queued', value: summary.queueDepth.toString(), inline: true },
        { name: 'Running', value: summary.runningCount.toString(), inline: true },
        { name: 'Pending approvals', value: summary.pendingApprovals.toString(), inline: true },
      ],
    })
  }

  private async handleShowInbox(): Promise<void> {
    const messages = queries.getUnreadMessages(this.db, 'all', 5)
    if (messages.length === 0) {
      await this.reply('Inbox is empty.')
      return
    }
    const lines = messages.map(m => `• [${m.kind}] ${m.body.slice(0, 200)}`).join('\n\n')
    await postToDiscord({
      sandboxDir: this.config.sandboxDir,
      title: `KAIROS — Inbox (${messages.length})`,
      body: lines.slice(0, 3500),
      severity: 'info',
    })
  }

  private async handleFreeTextTask(text: string, user: string): Promise<void> {
    const cwd = this.getActiveCwd()
    const taskId = queries.createTask(this.db, {
      description: text,
      sessionId: null,
      priority: 'high',
      permissionMode: 'bypass',
      workingDir: cwd,
    })
    this.triggerTick({ source: 'new_task', reason: `Discord free-text from @${user}` })
    await this.reply(`✓ Got it. Task \`${taskId}\`: "${text.slice(0, 80)}". I'll work on it.`)
    log(`Discord → free-text task ${taskId} from @${user}`)
  }

  /**
   * Decide if a message is conversational chat vs an actual task.
   * Chat → cheap Haiku reply, no task creation.
   * Task → full Sonnet subprocess flow.
   *
   * Heuristic: short messages matching common chat patterns are chat.
   * Anything longer or more directive is a task.
   */
  private classifyAsChat(text: string): boolean {
    const lower = text.toLowerCase().trim()
    const wordCount = lower.split(/\s+/).length

    // Long messages are tasks, period
    if (text.length > 80 || wordCount > 12) return false

    // Common conversational openers
    const chatPatterns = /^(hey|hi|hello|yo|sup|wassup|hola|thanks|thx|ty|ok|okay|cool|nice|sweet|great|awesome|perfect|wow|lol|haha|nope|yeah|yep|sure|alright|gotcha|got it|bye|gn|gm|good morning|good night|how are you|how('?s| is) it going|are you (alive|there|up)|you (alive|there|up)|ping|test)\b/i
    if (chatPatterns.test(lower)) return true

    // Questions about KAIROS itself (not about doing work) — keep cheap
    const aboutSelfPatterns = /^(what (can|do) you|who are you|what are you|how do you work)/i
    if (aboutSelfPatterns.test(lower)) return true

    // Imperative/action verbs strongly suggest a task
    const taskVerbs = /\b(check|run|test|build|deploy|commit|push|pull|fetch|install|update|fix|refactor|create|make|write|generate|send|notify|remind|monitor|watch|schedule|investigate|analyze|review|find|search|grep|list)\b/
    if (taskVerbs.test(lower)) return false

    // Short and not obviously a task → assume chat
    return wordCount <= 5
  }

  /**
   * Handle a conversational message — quick Haiku reply, no task creation.
   * ~$0.0003 + 1-2 seconds vs $0.05+ + 6+ seconds for a full task.
   */
  private async handleChat(text: string, user: string): Promise<void> {
    log(`Discord → quick chat reply (Haiku) for @${user}`)

    const prompt = `You are KAIROS, a witty and slightly sardonic always-on AI assistant. The user (@${user}) just sent you this message in your Discord channel:

"${text}"

Reply briefly. One or two sentences max. Voice: casual, witty, never corporate. Don't use "certainly", "of course", "absolutely". No greetings unless the user greeted you. If they're asking what's up or pinging you, give a quick state summary. Otherwise just reply naturally.`

    try {
      const proc = Bun.spawn(['claude', '-p', '--model', 'claude-haiku-4-5', '--output-format', 'json'], {
        stdin: new Blob([prompt]),
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const stdout = await new Response(proc.stdout).text()
      await proc.exited

      let reply = "Hey."
      try {
        const parsed = JSON.parse(stdout) as { result?: string }
        reply = (parsed.result ?? '').trim() || "Hey."
      } catch {
        // Use default
      }

      // Strip surrounding quotes if Claude wrapped its reply
      reply = reply.replace(/^["']|["']$/g, '').trim()

      await this.reply(reply)
    } catch (err) {
      logError('Discord chat reply failed', err)
      await this.reply('Yo. (Reply gen failed but I heard you.)')
    }
  }

  private async replyHelp(): Promise<void> {
    await postToDiscord({
      sandboxDir: this.config.sandboxDir,
      title: 'KAIROS — Commands',
      body: [
        '**Reply commands** (in this channel):',
        '`act <obs_id>` — handle an observation suggestion',
        '`dismiss <obs_id>` — ignore an observation (I\'ll learn)',
        '`approve <approval_id>` — allow a blocked command',
        '`deny <approval_id>` — block it permanently',
        '`status` — current daemon state',
        '`inbox` — show pending messages',
        '`help` — this menu',
        '',
        '**Anything else** → I create a task with that as the description.',
      ].join('\n'),
      severity: 'info',
    })
  }

  private async reply(text: string): Promise<void> {
    try {
      await fetch(
        `https://discord.com/api/v10/channels/${this.config.channelId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bot ${this.config.botToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ content: text }),
          signal: AbortSignal.timeout(5000),
        },
      )
    } catch (err) {
      logError('Discord reply failed', err)
    }
  }

  private getActiveCwd(): string {
    const session = this.db.query(
      'SELECT cwd FROM sessions WHERE disconnected_at IS NULL ORDER BY last_heartbeat DESC LIMIT 1',
    ).get() as { cwd: string } | null
    return session?.cwd ?? this.config.sandboxDir
  }
}

/**
 * Helper to load bot config from secrets.json. Returns null if not configured.
 */
export function loadBotConfig(sandboxDir: string): BotConfig | null {
  const path = join(sandboxDir, 'state', 'secrets.json')
  if (!existsSync(path)) return null
  try {
    const secrets = JSON.parse(readFileSync(path, 'utf8')) as {
      discord_bot_token?: string
      discord_channel_id?: string
    }
    if (!secrets.discord_bot_token || !secrets.discord_channel_id) return null
    return {
      botToken: secrets.discord_bot_token,
      channelId: secrets.discord_channel_id,
      sandboxDir,
    }
  } catch {
    return null
  }
}

// Discord conversation history with hierarchical context.
// Not a sliding window — a tiered structure:
//
//   1. RECENT: last N messages verbatim (default 12)
//   2. SUMMARIES: older message blocks compressed to topic summaries
//   3. PINNED: high-importance exchanges (decisions, prefs) always included
//
// On each new message: log it. Periodically: summarize old messages that
// fall out of the verbatim window. Importance scoring decides what gets
// pinned forever vs summarized vs dropped.

import type { Database } from 'bun:sqlite'
import { log, logError } from './logger'
import type { Config } from './types'

const DISCORD_HISTORY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS discord_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      TEXT NOT NULL,
    message_id      TEXT,
    role            TEXT NOT NULL,           -- 'user' or 'assistant'
    username        TEXT,
    content         TEXT NOT NULL,
    actions_json    TEXT,                    -- JSON array of actions emitted
    importance      REAL NOT NULL DEFAULT 0.5,  -- 0=trivial, 1=critical
    pinned          INTEGER NOT NULL DEFAULT 0,
    summarized_in   INTEGER,                 -- summary_id if subsumed
    ts              INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dmsg_channel_time
    ON discord_messages(channel_id, ts DESC);
  CREATE INDEX IF NOT EXISTS idx_dmsg_pinned
    ON discord_messages(pinned) WHERE pinned = 1;
  CREATE INDEX IF NOT EXISTS idx_dmsg_unsummarized
    ON discord_messages(channel_id, summarized_in)
    WHERE summarized_in IS NULL;

  CREATE TABLE IF NOT EXISTS discord_summaries (
    summary_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id      TEXT NOT NULL,
    covers_from     INTEGER NOT NULL,        -- ts of earliest message
    covers_to       INTEGER NOT NULL,        -- ts of latest message
    message_count   INTEGER NOT NULL,
    summary         TEXT NOT NULL,
    topic           TEXT,                    -- short topic label
    created_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_dsum_channel_time
    ON discord_summaries(channel_id, covers_to DESC);
`

export type DiscordMessageRow = {
  id: number
  channel_id: string
  message_id: string | null
  role: 'user' | 'assistant'
  username: string | null
  content: string
  actions_json: string | null
  importance: number
  pinned: number
  summarized_in: number | null
  ts: number
}

export type DiscordSummaryRow = {
  summary_id: number
  channel_id: string
  covers_from: number
  covers_to: number
  message_count: number
  summary: string
  topic: string | null
  created_at: number
}

export class DiscordHistory {
  private summarizing = false
  private readonly RECENT_WINDOW = 12        // last N messages verbatim
  private readonly SUMMARIZE_THRESHOLD = 20  // when to compress
  private readonly MAX_SUMMARIES_IN_CTX = 5  // older summary blocks to include
  private readonly TRIVIAL_IMPORTANCE_THRESHOLD = 0.2  // dropped from summarization

  constructor(
    private db: Database,
    private config: Config,
    // Summarization brain. Injected OpenRouter completer (fast model) — replaces
    // the old `claude -p` Haiku subprocess. No claude at runtime.
    private llm?: { complete: (body: any) => Promise<{ text: string }> },
  ) {
    this.db.exec(DISCORD_HISTORY_SCHEMA)
  }

  /**
   * Log a user message coming in from Discord.
   */
  logUserMessage(params: {
    channelId: string
    messageId: string
    username: string
    content: string
  }): number {
    const importance = this.scoreUserImportance(params.content)
    const result = this.db.query(
      `INSERT INTO discord_messages (channel_id, message_id, role, username, content, importance, ts)
       VALUES (?, ?, 'user', ?, ?, ?, ?) RETURNING id`,
    ).get(params.channelId, params.messageId, params.username, params.content, importance, Date.now()) as { id: number }
    return result.id
  }

  /**
   * Log KAIROS's reply to Discord.
   */
  logAssistantReply(params: {
    channelId: string
    content: string
    actions: Array<{ verb: string; payload: string }>
  }): number {
    const importance = this.scoreAssistantImportance(params.content, params.actions)
    const result = this.db.query(
      `INSERT INTO discord_messages (channel_id, role, content, actions_json, importance, ts)
       VALUES (?, 'assistant', ?, ?, ?, ?) RETURNING id`,
    ).get(
      params.channelId,
      params.content,
      JSON.stringify(params.actions),
      importance,
      Date.now(),
    ) as { id: number }
    return result.id
  }

  /**
   * Pin a message so it's always included in context (e.g., user preference).
   */
  pin(messageId: number): void {
    this.db.run('UPDATE discord_messages SET pinned = 1 WHERE id = ?', [messageId])
  }

  /**
   * Build the conversation context block for the agent prompt.
   * Three tiers: pinned + summaries + recent verbatim.
   */
  buildContextBlock(channelId: string): string {
    const parts: string[] = []

    // 1. PINNED messages (always included, regardless of age)
    const pinned = this.db.query(
      `SELECT * FROM discord_messages
       WHERE channel_id = ? AND pinned = 1
       ORDER BY ts ASC`,
    ).all(channelId) as DiscordMessageRow[]

    if (pinned.length > 0) {
      parts.push('## Pinned context')
      parts.push('')
      for (const m of pinned) {
        parts.push(this.formatMessage(m))
      }
      parts.push('')
    }

    // 2. SUMMARIES of older messages (compressed)
    const summaries = this.db.query(
      `SELECT * FROM discord_summaries
       WHERE channel_id = ?
       ORDER BY covers_to DESC LIMIT ?`,
    ).all(channelId, this.MAX_SUMMARIES_IN_CTX) as DiscordSummaryRow[]

    if (summaries.length > 0) {
      parts.push('## Earlier conversation (summarized)')
      parts.push('')
      // Display oldest first
      for (const s of summaries.reverse()) {
        const topic = s.topic ? ` [${s.topic}]` : ''
        parts.push(`<summary covers="${s.message_count} messages from ${this.relTime(s.covers_from)} to ${this.relTime(s.covers_to)}"${topic}>`)
        parts.push(s.summary)
        parts.push('</summary>')
        parts.push('')
      }
    }

    // 3. RECENT verbatim (the last N messages, regardless of summarization)
    const recent = this.db.query(
      `SELECT * FROM discord_messages
       WHERE channel_id = ? AND pinned = 0
       ORDER BY ts DESC LIMIT ?`,
    ).all(channelId, this.RECENT_WINDOW) as DiscordMessageRow[]

    if (recent.length > 0) {
      parts.push('## Recent conversation (verbatim)')
      parts.push('')
      // Reverse so oldest-first reads naturally
      for (const m of recent.reverse()) {
        parts.push(this.formatMessage(m))
      }
    }

    if (parts.length === 0) {
      return '(No prior conversation in this channel)'
    }
    return parts.join('\n')
  }

  /**
   * Periodic background task: summarize old un-summarized messages.
   * Should be called every few minutes from the scheduler or a timer.
   */
  async maybeSummarize(channelId: string): Promise<void> {
    if (this.summarizing) return

    // Find messages that are: in this channel, not pinned, not summarized,
    // and OUTSIDE the recent verbatim window
    const candidates = this.db.query(
      `SELECT * FROM discord_messages
       WHERE channel_id = ?
         AND pinned = 0
         AND summarized_in IS NULL
         AND id NOT IN (
           SELECT id FROM discord_messages
           WHERE channel_id = ? AND pinned = 0
           ORDER BY ts DESC LIMIT ?
         )
         AND importance >= ?
       ORDER BY ts ASC`,
      ).all(channelId, channelId, this.RECENT_WINDOW, this.TRIVIAL_IMPORTANCE_THRESHOLD) as DiscordMessageRow[]

    if (candidates.length < this.SUMMARIZE_THRESHOLD) return

    this.summarizing = true
    try {
      log(`Summarizing ${candidates.length} old Discord messages for channel ${channelId.slice(0, 12)}`)

      const transcript = candidates.map(m => this.formatMessage(m)).join('\n')

      const prompt = `You are summarizing a Discord conversation between a user and KAIROS, an AI assistant.

The transcript below contains ${candidates.length} messages. Compress them into a concise summary that preserves:
- What the user wanted to do (decisions, plans, requests)
- What KAIROS did (skills generated, tasks created, schedules set)
- Any preferences/conventions established
- Outcomes (what worked, what failed)

DROP: small talk, greetings, acknowledgments, repeated info.

Output two lines:
TOPIC: <3-5 word topic label>
SUMMARY: <2-4 sentence summary>

Transcript:
${transcript}`

      if (!this.llm) {
        log('Discord summarization skipped — no LLM configured', 'warn')
        return
      }
      const resp = await this.llm.complete({ messages: [{ role: 'user', content: prompt }], max_tokens: 300 })
      const result = resp.text ?? ''

      const topicMatch = result.match(/TOPIC:\s*(.+)/)
      const summaryMatch = result.match(/SUMMARY:\s*([\s\S]+)/)

      const topic = topicMatch?.[1]?.trim() ?? null
      const summary = summaryMatch?.[1]?.trim() ?? result.trim()

      if (!summary) {
        log(`Summarization produced empty result for channel ${channelId.slice(0, 12)}`, 'warn')
        return
      }

      // Insert summary
      const sumResult = this.db.query(
        `INSERT INTO discord_summaries (channel_id, covers_from, covers_to, message_count, summary, topic, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING summary_id`,
      ).get(
        channelId,
        candidates[0]!.ts,
        candidates[candidates.length - 1]!.ts,
        candidates.length,
        summary,
        topic,
        Date.now(),
      ) as { summary_id: number }

      // Mark candidates as summarized
      const ids = candidates.map(c => c.id)
      const placeholders = ids.map(() => '?').join(',')
      this.db.run(
        `UPDATE discord_messages SET summarized_in = ? WHERE id IN (${placeholders})`,
        [sumResult.summary_id, ...ids],
      )

      log(`Compressed ${candidates.length} messages → summary ${sumResult.summary_id} (${topic ?? 'no topic'})`)
    } catch (err) {
      logError('Discord summarization failed', err)
    } finally {
      this.summarizing = false
    }
  }

  /**
   * Score how important a user message is. Higher = stays verbatim longer.
   * Heuristics: length, presence of code/URLs, command-like syntax.
   */
  private scoreUserImportance(content: string): number {
    let score = 0.5  // base
    const len = content.length

    // Very short messages are usually low-importance acks
    if (len < 10) score -= 0.3
    if (len > 200) score += 0.2
    if (len > 500) score += 0.2

    // Greetings/thanks/acks
    if (/^(hi|hey|hello|yo|ok|okay|thanks|ty|cool|nice|got it|sure)\b/i.test(content.trim())) {
      score -= 0.3
    }

    // Questions or commands
    if (content.includes('?')) score += 0.1
    if (/^(can you|please|could you|do |make |build |create |write |run )/i.test(content.trim())) {
      score += 0.2
    }

    // Code / URLs / file paths suggest substantive content
    if (/```|http[s]?:\/\/|\/[a-z_-]+\/[a-z_-]+/i.test(content)) score += 0.2

    return Math.max(0, Math.min(1, score))
  }

  /**
   * Score how important an assistant reply is. Higher = stays verbatim longer.
   * Heuristics: action blocks emitted (decisions matter), length, presence of code.
   */
  private scoreAssistantImportance(content: string, actions: Array<{ verb: string; payload: string }>): number {
    let score = 0.5

    // Replies that triggered real work are important
    if (actions.length > 0) score += 0.3

    // High-impact actions even more so
    const heavyActions = new Set([
      'GENERATE_SKILL', 'PROPOSE_PATCH', 'APPROVE_PATCH',
      'EXPERIMENT_PROMPT', 'PROMOTE_PROMPT', 'FILL_GAP',
    ])
    if (actions.some(a => heavyActions.has(a.verb))) score += 0.2

    // Trivial replies
    if (/^(anytime|sure|ok|got it|done|on it)\.?$/i.test(content.trim())) score -= 0.2

    return Math.max(0, Math.min(1, score))
  }

  private formatMessage(m: DiscordMessageRow): string {
    const role = m.role === 'user' ? `@${m.username ?? 'user'}` : '@kairos'
    const time = this.relTime(m.ts)
    const actions = m.actions_json && m.actions_json !== '[]'
      ? ` (actions: ${(JSON.parse(m.actions_json) as Array<{ verb: string }>).map(a => a.verb).join(', ')})`
      : ''
    return `[${time}] ${role}: ${m.content}${actions}`
  }

  private relTime(ts: number): string {
    const ago = Date.now() - ts
    if (ago < 60_000) return 'just now'
    if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`
    if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`
    return `${Math.floor(ago / 86_400_000)}d ago`
  }

  /**
   * Inspection helper: get the full history (verbatim + summary count).
   */
  getStats(channelId: string): {
    total_messages: number
    pinned: number
    summarized: number
    summary_count: number
  } {
    const total = (this.db.query(
      'SELECT COUNT(*) as n FROM discord_messages WHERE channel_id = ?',
    ).get(channelId) as { n: number }).n
    const pinned = (this.db.query(
      'SELECT COUNT(*) as n FROM discord_messages WHERE channel_id = ? AND pinned = 1',
    ).get(channelId) as { n: number }).n
    const summarized = (this.db.query(
      'SELECT COUNT(*) as n FROM discord_messages WHERE channel_id = ? AND summarized_in IS NOT NULL',
    ).get(channelId) as { n: number }).n
    const summary_count = (this.db.query(
      'SELECT COUNT(*) as n FROM discord_summaries WHERE channel_id = ?',
    ).get(channelId) as { n: number }).n
    return { total_messages: total, pinned, summarized, summary_count }
  }
}

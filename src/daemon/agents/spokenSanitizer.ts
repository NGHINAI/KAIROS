// src/daemon/agents/spokenSanitizer.ts
//
// THE single guard for "KAIROS must never SPEAK internal text." Anything that reaches
// TTS goes through here. Two surfaces:
//   • sanitizeSpoken(text)  — for COMPLETE strings (final replies, background reports,
//     approval lines): strip <think>/<reasoning> chain-of-thought blocks, and if the
//     model emitted a tool CALL as plain text, replace the whole thing with a recovery
//     line (never voice raw tool markup).
//   • SpokenStreamFilter    — for the LIVE token stream (streamSpeechController): same
//     rules applied incrementally, holding back a short tail so a tag split across
//     deltas is never spoken early, and POISONING the stream the moment tool-markup
//     appears (stop speaking; the end-of-turn sanitize then speaks the recovery line).
//
// Mirrors the openRouterAdapter's stripThink+holdback (that strips the SEPARATE
// reasoning channel upstream; this is defense-in-depth at the speech boundary, and it
// also catches tool-markup which the adapter does not).

const THINK_BLOCK_RE = /<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi
const THINK_DANGLING_RE = /<(think|thinking|reasoning|thought)>[\s\S]*$/i
// A tool call emitted as TEXT (some models/providers do this) — must NEVER be spoken.
const TOOL_MARKUP_RE = /<tool_call|tool_calls_section|<\|tool|functions\.[a-zA-Z_]+\s*[\{<]/
// A trailing fragment that COULD be the start of a sensitive tag/markup. We hold ONLY
// this back (not arbitrary text), so normal speech streams with zero delay while a
// budding "<thi…" / "functions.gmail_sen…" never escapes before it resolves.
const SUSPICIOUS_TAIL_RE = /(<[a-z|/]*|functions\.?[a-zA-Z_]*|tool_call[a-z_]*)$/i

const RECOVERY_LINE = "Sorry, I hit a snag running that — let me try again in a moment."

// ── Markdown that TTS would VERBALIZE ("star", "hash", "backtick", "underscore") ──
// The model often formats with markdown; spoken, the punctuation is read aloud. Strip it.
const MD_FENCE_RE = /```[\s\S]*?```/g          // fenced code block → drop
const MD_INLINE_CODE_RE = /`([^`]+)`/g          // `code` → code
const MD_LINK_RE = /!?\[([^\]]+)\]\([^)]*\)/g    // [label](url) / ![alt](src) → label
const MD_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+/gm   // ### Heading → Heading
const MD_BULLET_RE = /^[ \t]*[-*+][ \t]+/gm     // "* item" / "- item" → "item"
const MD_BOLD_RE = /(\*\*|__)(.+?)\1/g           // **bold** / __bold__ → bold
const MD_ITALIC_RE = /(\*|_)(.+?)\1/g            // *italic* / _italic_ → italic
const MD_STRAY_RE = /[*_`#>~|]/g                 // any leftover markdown char TTS would say

/** Strip markdown formatting so TTS speaks the words, never the punctuation. */
function stripSpeakableMarkdown(s: string): string {
  return s
    .replace(MD_FENCE_RE, " ").replace(MD_INLINE_CODE_RE, "$1").replace(MD_LINK_RE, "$1")
    .replace(MD_HEADING_RE, "").replace(MD_BULLET_RE, "")
    .replace(MD_BOLD_RE, "$2").replace(MD_ITALIC_RE, "$2").replace(MD_STRAY_RE, "")
}

// ── Internal implementation names that must NEVER be voiced ──────────────────────
// The user hears in their OWN terms (Gmail, Calendar) — never our plumbing.
const INTERNAL_TERMS_RE = /\b(?:composio|mcp(?: server)?)\b/gi   // Composio / MCP → neutral
// A raw tool slug leaked into prose, e.g. "GMAIL_SEND_EMAIL" or "GOOGLECALENDAR_CREATE_EVENT".
const TOOL_SLUG_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g
// Machine identifiers TTS would spell out character-by-character ("two two five d c d…").
// UUIDs (with or without dashes) and long hex/opaque tokens. Spoken text has no business
// containing these — the prompt says present items BY NAME; this is the hard backstop.
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi
const LONG_HEX_RE = /\b[0-9a-f]{16,}\b/gi
// Filler left behind once the id is gone ("with ID ," / "whose id is .").
const ORPHAN_ID_PHRASE_RE = /\b(?:with|whose|its|the)?\s*id(?:entifier)?\s*(?:is|:)?\s*(?=[,.;)\s]|$)/gi

/** Replace internal infra names + raw tool slugs + machine ids with human words. */
function scrubInternal(s: string): string {
  return s
    .replace(TOOL_SLUG_RE, (m) => m.toLowerCase().replace(/_/g, " "))   // GMAIL_SEND_EMAIL → "gmail send email"
    .replace(INTERNAL_TERMS_RE, "the integration")
    .replace(UUID_RE, "")
    .replace(LONG_HEX_RE, "")
    .replace(ORPHAN_ID_PHRASE_RE, "")
}

/** Tidy spacing left by the strips/scrubs: collapse all whitespace (incl. newlines, so a
 *  multi-line report speaks as continuous prose) and drop a space before punctuation. */
function tidy(s: string): string {
  return s.replace(/\s+/g, " ").replace(/ ([,.;:!?])/g, "$1").trim()
}

/** Sanitize a COMPLETE spoken string. "" if nothing speakable remains. */
export function sanitizeSpoken(text: unknown): string {
  const t = String(text ?? "").replace(THINK_BLOCK_RE, " ").replace(THINK_DANGLING_RE, " ").trim()
  if (!t) return ""
  if (TOOL_MARKUP_RE.test(t)) return RECOVERY_LINE
  return tidy(stripSpeakableMarkdown(scrubInternal(t)))
}

/** Light, stream-safe version of the scrubs (char-level only — no cross-delta regexes). */
function stripStreamSpeakable(s: string): string {
  return s.replace(INTERNAL_TERMS_RE, "the integration").replace(MD_STRAY_RE, "")
}

/** Streaming-safe filter for the live delta path. One instance per turn. */
export class SpokenStreamFilter {
  private raw = ""
  private emitted = 0
  private poisoned = false

  /** Feed a delta; returns the safe-to-speak increment (often ""). Once tool-markup
   *  appears anywhere in the stream, every subsequent push returns "" (poisoned). */
  push(delta: string): string {
    if (this.poisoned) return ""
    this.raw += delta
    if (TOOL_MARKUP_RE.test(this.raw)) { this.poisoned = true; return "" }
    // Strip complete + dangling <think> blocks from the WHOLE accumulated stream, then
    // emit the newly-clean text EXCEPT a trailing fragment that could be a budding tag.
    const clean = this.raw.replace(THINK_BLOCK_RE, " ").replace(THINK_DANGLING_RE, "")
    const m = clean.match(SUSPICIOUS_TAIL_RE)
    const safeEnd = m ? clean.length - m[0].length : clean.length
    if (safeEnd > this.emitted) {
      const out = clean.slice(this.emitted, safeEnd)
      this.emitted = safeEnd
      return stripStreamSpeakable(out)
    }
    return ""
  }

  /** Flush at end of stream: a trailing fragment that never resolved into markup is
   *  just ordinary text (a stray "<" etc.), safe to emit now. */
  flush(): string {
    if (this.poisoned) return ""
    const clean = this.raw.replace(THINK_BLOCK_RE, " ").replace(THINK_DANGLING_RE, "")
    if (clean.length > this.emitted) {
      const out = clean.slice(this.emitted)
      this.emitted = clean.length
      return stripStreamSpeakable(out)
    }
    return ""
  }

  /** True if the stream was poisoned by tool-markup → the live answer was suppressed,
   *  so the conductor should speak the sanitized end-of-turn final instead. */
  poisonedFinal(): boolean { return this.poisoned }
}

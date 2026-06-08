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

/** Sanitize a COMPLETE spoken string. "" if nothing speakable remains. */
export function sanitizeSpoken(text: unknown): string {
  const t = String(text ?? "").replace(THINK_BLOCK_RE, " ").replace(THINK_DANGLING_RE, " ").trim()
  if (!t) return ""
  if (TOOL_MARKUP_RE.test(t)) return RECOVERY_LINE
  return t
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
      return out
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
      return out
    }
    return ""
  }

  /** True if the stream was poisoned by tool-markup → the live answer was suppressed,
   *  so the conductor should speak the sanitized end-of-turn final instead. */
  poisonedFinal(): boolean { return this.poisoned }
}

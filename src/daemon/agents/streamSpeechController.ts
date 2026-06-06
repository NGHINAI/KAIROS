// src/daemon/agents/streamSpeechController.ts
// Drives live voice from the agent loop's events (Phase 3 — kill dead air).
// - assistant_delta → feed the StreamingSpeaker so the answer is spoken AS IT
//   generates (sentence-by-sentence), not after the whole turn.
// - tool_call_start → speak a short ack ("on it…") BEFORE the tool runs.
// - filler → if nothing happens for a beat, say a one-off "one sec" so the user
//   never sits in silence.
// Mostly dumb: it turns loop events into audio. The ONE policy it enforces is the
// "block writes" half of the grounded-verify design: once an IRREVERSIBLE tool
// fires this turn, it stops speaking the model's live final claim (the answer the
// model streams AFTER acting) and lets the conductor speak the VERIFIED final at
// the end instead — so KAIROS never voices "done, deleted" before the verify gate
// confirms it. Pre-action narration + the tool ack still stream live (no dead air).
// Read-only turns are unaffected: their answer streams live as before.

import type { LoopEvent } from "./loop/types"

export interface SpeakSink {
  begin(): void
  feed(text: string): void
  end(): Promise<void>
  cancel(): void
}

export interface StreamSpeechDeps {
  speaker: SpeakSink
  /** Short ack FED INLINE to the same speaker when a tool starts ("on it… ").
   *  Returns "" to skip. Fed inline (not a separate begin/end) so it never
   *  clobbers the in-flight delta stream. Receives the tool args so it can be
   *  tool-aware (e.g. read args.tool_name for execute_tool). */
  ackPhrase?: (toolName: string, args?: any) => string
  /** Arm a filler if no loop event arrives within this many ms (0/undefined = off).
   *  Re-armed after each tool starts, so a LONG-running tool emits a "still on it"
   *  instead of dead silence. */
  fillerMs?: number
  /** Instant filler phrase fed INLINE when the timer fires ("still on it…").
   *  Receives the last tool that started so the filler can reference the in-flight
   *  action ("still on your issues…"). */
  fillerPhrase?: (lastTool?: { name: string; args: any }) => string
  /** Max fillers per wait, so a slow tool doesn't trigger an endless trickle. Default 2. */
  maxFillers?: number
  /** "Block writes": returns true if a tool call touches irreversible state. When it
   *  does, the controller stops speaking the model's live final claim for the rest
   *  of the turn (the conductor speaks the VERIFIED final at the end instead).
   *  Receives the tool args so it can unwrap execute_tool's tool_name. Omitted = off. */
  isDestructive?: (toolName: string, args?: any) => boolean
  onFiller?: () => void
  /** Injectable timer (tests). Default setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, ms: number) => any
  clearTimer?: (handle: any) => void
}

export class StreamSpeechController {
  private spoken = ""
  private held = ""            // final claim withheld from live speech on a write turn
  private suppressed = false   // a destructive tool fired → stop speaking the live final
  private fillerHandle: any = null
  private cancelled = false
  private fillerCount = 0
  private lastTool: { name: string; args: any } | undefined

  constructor(private deps: StreamSpeechDeps) {}

  begin(): void {
    this.spoken = ""
    this.held = ""
    this.suppressed = false
    this.cancelled = false
    this.fillerCount = 0
    this.deps.speaker.begin()
    this.armFiller()
  }

  handle(e: LoopEvent): void {
    if (this.cancelled) return
    switch (e.kind) {
      case "assistant_delta":
        this.clearFiller()
        // After an irreversible tool fired, HOLD the model's live final claim —
        // don't speak it until the conductor has the verified answer. (The text is
        // still recorded in `held` for reference; the canonical reply comes from
        // the loop result, not from here.)
        if (this.suppressed) { this.held += e.text; break }
        this.spoken += e.text
        this.deps.speaker.feed(e.text)
        break
      case "tool_call_start": {
        this.clearFiller()
        // Live ack BEFORE execution — fed INLINE to the same stream so it can't
        // clobber the delta buffer. This is what removes the dead air. The ack is
        // a pre-action intent ("okay, deleting that now"), not a result claim, so
        // it's safe to speak even on a write turn.
        this.lastTool = { name: e.name, args: e.args }
        const phrase = this.deps.ackPhrase?.(e.name, e.args)
        if (phrase) { const out = phrase.endsWith(" ") ? phrase : phrase + " "; this.spoken += out; this.deps.speaker.feed(out) }
        // "Block writes": from here on, withhold the live final claim — the
        // conductor speaks the verified result at the end instead.
        if (this.deps.isDestructive?.(e.name, e.args)) this.suppressed = true
        // Re-arm the filler for THIS tool: if it runs long, the user hears
        // "still on it" rather than silence until the result comes back.
        this.fillerCount = 0
        this.armFiller()
        break
      }
      // assistant text was already streamed via deltas; `final`/tool_done/etc.
      // need no extra speech here.
      default:
        break
    }
  }

  /** Flush + close the speaker. Returns everything streamed (for reference). */
  async finish(): Promise<string> {
    this.clearFiller()
    if (!this.cancelled) {
      try { await this.deps.speaker.end() } catch { /* never throw on close */ }
    }
    return this.spoken
  }

  /** Barge-in: stop the speaker and ignore any further events. */
  cancel(): void {
    this.cancelled = true
    this.clearFiller()
    try { this.deps.speaker.cancel() } catch { /* */ }
  }

  spokenText(): string {
    return this.spoken
  }

  /** True if a destructive tool fired this turn, so the live final claim was held
   *  back. The conductor uses this to speak the VERIFIED final at the end. */
  suppressedFinal(): boolean {
    return this.suppressed
  }

  /** The final claim that was withheld from live speech (for reference/tests). */
  heldText(): string {
    return this.held
  }

  private armFiller(): void {
    const ms = this.deps.fillerMs ?? 0
    // Need a reason to fire: either an inline phrase to speak, or a notify hook.
    if (!ms || (!this.deps.fillerPhrase && !this.deps.onFiller)) return
    const max = this.deps.maxFillers ?? 2
    const setT = this.deps.setTimer ?? ((fn: () => void, m: number) => setTimeout(fn, m))
    this.fillerHandle = setT(() => {
      this.fillerHandle = null
      if (this.cancelled || this.fillerCount >= max) return
      this.fillerCount++
      // Speak the filler INLINE on the same stream (never begin()/clobber).
      const phrase = this.deps.fillerPhrase?.(this.lastTool)
      if (phrase) { const out = phrase.endsWith(" ") ? phrase : phrase + " "; this.spoken += out; this.deps.speaker.feed(out) }
      try { this.deps.onFiller?.() } catch { /* */ }
      this.armFiller() // keep covering a still-running tool, up to maxFillers
    }, ms)
  }

  private clearFiller(): void {
    if (this.fillerHandle != null) {
      const clearT = this.deps.clearTimer ?? clearTimeout
      clearT(this.fillerHandle)
      this.fillerHandle = null
    }
  }
}

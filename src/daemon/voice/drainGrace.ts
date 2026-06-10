// src/daemon/voice/drainGrace.ts
// Drain-grace supersede (truncation diagnosis #4-b, 2026-06-07): when a new
// utterance supersedes the previous turn, the old behavior unconditionally
// cancelled the shared StreamingSpeaker — cutting an almost-finished reply off
// mid-word ("Your next meeting is at thr—"). The conductor turn is still aborted
// (the LLM stops generating), but a SHORT spoken tail is allowed to finish its
// sentence before the new turn takes the speaker. A long in-flight reply is a real
// interrupt and is cancelled immediately, as before.
//
// Knobs: KAIROS_DRAIN_GRACE_CHARS (tail size that counts as "nearly finished",
// default 120 ≈ one sentence) · KAIROS_DRAIN_GRACE_MS (max wait, default 2500).

export interface DrainableSpeaker {
  remaining(): number
  drainQuietly(capMs: number): Promise<boolean>
  cancel(): void
}

export type SupersedeOutcome = "idle" | "drained" | "cancelled"

export async function supersedeSpeech(
  speaker: DrainableSpeaker,
  opts?: { graceChars?: number; graceMs?: number },
): Promise<SupersedeOutcome> {
  const graceChars = opts?.graceChars ?? (Number(process.env.KAIROS_DRAIN_GRACE_CHARS) || 120)
  const graceMs = opts?.graceMs ?? (Number(process.env.KAIROS_DRAIN_GRACE_MS) || 2500)

  let tail = 0
  try { tail = speaker.remaining() } catch { tail = Infinity }

  if (tail === 0) return "idle"                       // nothing pending — nothing to cut

  if (tail <= graceChars) {
    try {
      if (await speaker.drainQuietly(graceMs)) return "drained"
    } catch { /* fall through to cancel */ }
  }

  try { speaker.cancel() } catch { /* */ }
  return "cancelled"
}

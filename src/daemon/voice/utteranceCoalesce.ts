// src/daemon/voice/utteranceCoalesce.ts
//
// Coalesce STT fragments of ONE breath (2026-06-07 diagnosis #4-truncation d). The
// end-of-utterance detector can split a single utterance into two finals ("Okay." +
// "Can you?" 751ms apart); without coalescing, the second fragment supersedes the first
// and truncates its reply. If the PREVIOUS turn is still in flight (priorLive) and this
// fragment arrived within ~a breath, fold the prior text in and answer ONCE. A turn that
// already FINISHED is not "live", so a genuinely new utterance never coalesces.

export interface CoalesceState { text: string; at: number }

export function coalesceFragment(
  prev: CoalesceState | undefined,
  current: string,
  now: number,
  opts: { coalesceMs: number; priorLive: boolean },
): string {
  if (opts.coalesceMs > 0 && opts.priorLive && prev && now - prev.at < opts.coalesceMs) {
    return `${prev.text} ${current}`.trim()
  }
  return current
}

// src/daemon/agents/loop/verifier.ts
// Grounded-claim verify gate. The ONLY question that generalizes across every
// failure class is: "is everything the agent is about to SAY actually supported
// by what the tools RETURNED?" A cheap fast-model judge compares the claim
// against the FULL tool ledger (reads included) — no verb lists, no keyword
// matching on the user's words. This catches BOTH:
//   • a phantom action ("Done. Deleted." when no delete tool ran), AND
//   • a misread ("your last email is from X" when the fetch returned Y).
// A FREE deterministic pre-check handles the highest-value case — a write tool
// that ERRORED while the agent claims success — with no LLM call at all.
// Never blocks on its own failure (a verifier crash must not strand a real reply).

export interface VerifyToolCall {
  name: string
  args?: any
  result?: any
  error?: string
}

// ── AGENTIC read-vs-write classification (no hardcoded verb lists) ────────────
// Read vs write decides ONLY latency tiering (hold a write's spoken claim until
// verified vs let a read stream live) + the errored-write fast path. The grounding
// LLM judges hallucinations on EVERY tool turn regardless, so this never decides
// correctness. The nature of each EXTERNAL tool is the MODEL's own one-time
// classification of that tool's description (computed + cached by ComposioToolResolver
// — see classifyNatures there), set here at boot/refresh. Works for ANY toolkit; no
// word list to maintain. Our own confined/internal tools are known a priori.
let toolNature: Map<string, "read" | "write"> | null = null
/** Install the per-tool nature map (slug → 'read'|'write'). Called at boot and on
 *  each catalog refresh. Reaches the verifier, the stream controller, AND the
 *  background approval-gate automatically — they all call isDestructiveCall. */
export function setToolNature(m: Map<string, "read" | "write"> | null): void { toolNature = m }

const DESTRUCTIVE_NAMES = new Set(["connect_service", "disconnect_service", "setup_for"])

// Our OWN confined scratch/plan tools + INTERNAL orchestration tools — none touch
// external irreversible state, so they're never a "write" (which would gate them for
// approval and hang the sub-agent) and never need grounding. This is a list of OUR
// tools, not a guess about third-party toolkits.
const LOCAL_TOOLS = new Set([
  "read_file", "list_dir", "write_file", "edit_file", "grep", "glob", "update_plan", "run_shell",
  "run_subtask", "spawn_background_task", "background_tasks",
  // KAIROS's own read-only discovery tools (not third-party toolkits) — harmless, must
  // never be approval-gated (the sub-agent searches constantly).
  "search_tools", "find_integration", "recall_memory", "web_search", "read_webpage",
  // guide_user only POINTS at the screen (the user does the clicking) — read-only.
  // read_screen reads the AX element inventory — read-only.
  // open_app launches a macOS app by name (argv-only `open -a`) — benign, reversible.
  // end_lesson closes the guide session (retracts the overlay) — local state only.
  // click_element/type_text act on the USER'S OWN screen at their spoken request —
  // OUR tools with their own label-based confirm gate (DANGEROUS_LABEL_RE in
  // guideTools); routing them through the background approval-gate would hang
  // every foreground "switch to dark mode" on a pointless approval.
  "guide_user", "read_screen", "wait_for_screen", "guide_scroll", "open_app", "end_lesson",
  "click_element", "type_text",
  // cua_click acts on the USER'S screen at their spoken request (vision/pixel fallback for
  // click_element) — OUR tool, never an external/destructive write.
  "cua_click",
])

/** The real action name — unwrapping execute_tool's wrapped tool_name. */
function effectiveName(call: VerifyToolCall): string {
  if (call.name === "execute_tool") return String(call.args?.tool_name ?? "")
  return call.name
}

/** Does this call mutate external/irreversible state? From the agentic per-tool
 *  nature map (the model's own read/write classification of the tool), with our
 *  internal tools known a priori. For an UNMAPPED external tool, `unmappedDefault`
 *  decides: 'read' (verifier/controller — stream live; the grounding LLM still
 *  verifies) or 'write' (approval-gate — gate the unknown, the safe side). */
export function isDestructiveCall(call: VerifyToolCall, opts?: { unmappedDefault?: "read" | "write" }): boolean {
  // Our confined/internal tools — never external, never approval-gated. The kairos_*
  // introspection/self-management tools (kairos_composio_status, kairos_help,
  // kairos_memory_*, kairos_activity, …) are all OURS — without this they were
  // mis-gated as destructive writes (unmappedDefault), pausing sub-agents for a
  // pointless human approval on a read (2026-06-07 diagnosis #3).
  if (LOCAL_TOOLS.has(call.name) || call.name.startsWith("kairos_")) return false
  const name = effectiveName(call)
  if (DESTRUCTIVE_NAMES.has(call.name) || DESTRUCTIVE_NAMES.has(name)) return true
  const nat = toolNature?.get(name) ?? toolNature?.get(call.name)
  if (nat) return nat === "write"
  return (opts?.unmappedDefault ?? "read") === "write"
}

/** Did the tool call fail? Looks at the error field AND common Composio/REST
 *  failure shapes in the result body (successful:false, error, failed status). */
function callErrored(c: VerifyToolCall): boolean {
  if (c.error) return true
  const r: any = c.result
  if (r && typeof r === "object") {
    if (r.error || r.successful === false || r.success === false || r.ok === false) return true
    if (typeof r.status === "string" && /\b(fail|failed|error|denied|unauthor|not[_ ]?connected)\b/i.test(r.status)) return true
  }
  return false
}

// A short final that PROMISES instead of answering ("one moment", "I'll check", "I'm going to
// create it") — the turn would end with the user waiting for something that will never come.
// Exported: the memory layer reuses this to keep KAIROS's own promissory replies OUT of
// long-term memory (recalled promises teach the model to re-promise instead of working —
// the 2026-06-10 flight-research parroting loop).
// A guided-walkthrough ask. Shared: the verifier's walkthrough gates key on it, the
// planner runner enables THINKING on the smart model for these turns (protocol-
// following needs reasoning; voice chit-chat keeps thinking off for latency), and
// the lesson manager uses it to decide whether a point starts a durable lesson.
// Broadened 2026-06-10: the live session's "how to switch", "how I can switch" and
// "show me how" all slipped past the old pattern and were answered from memory.
// "how to <verb>" is verb-listed so "how to think about X" stays a plain question.
export const TEACHING_RE =
  /\b(teach|walk me through|guide me through|show me how|how (do|to|can) (i|we|you)\b|how i can\b|how to (switch|change|open|turn|enable|disable|set|use|find|adjust|connect|add|remove|install|create|make|get to)\b)\b/i

// A pointing ask ("show me where X is", "highlight it again") — needs the LOOK and
// POINT gates (an answer with zero guide tools is fabrication-from-memory) but NOT
// the full walkthrough mechanics: pointing IS the complete answer, no forced wait.
export const GUIDE_RE = /\b(show me where|highlight|point (at|to|out))\b/i

// An imperative DO ask ("switch my Mac to light mode", "turn on do not disturb") —
// the user wants it DONE, not taught. Evaluated only when TEACHING_RE didn't match.
export const DO_ASK_RE =
  /^(hey[,!]? |kairos[,!]? )?(please |now |okay,? |can you |could you |would you )*(switch|turn|change|set|enable|disable|toggle|open|close|put|move|adjust|make|click|select)\b/i

// A final that hands the action BACK to the user ("please click on that") — on a
// DO ask this is the model doing half the job and outsourcing the click it could
// have performed itself. \bclick\b doesn't match "clicked", so grounded past-tense
// reports ("I clicked Dark") never trip this.
const TELLS_USER_TO_ACT_RE =
  /\b(please |you (can|should|need to) |go ahead and )?(click|select|choose|press|tap)\b[^.?!]{0,50}\b(that|it|on|the)\b/i

// The model asking the USER to describe their own screen — it has read_screen for
// that. A question-final exemption must never launder this particular offload.
const SCREEN_OFFLOAD_RE =
  /\b(tell me what('?s| is) on (your|the) screen|what app (are you|you'?re) (in|on|using)|what (are you|you'?re) looking at|describe (your|the) screen|what do you see|where did you see)\b/i

// The model claiming it CAN'T see/read the screen or that the guide is broken.
// Only a lie when the ledger shows a SUCCESSFUL read/point this turn — checked at
// the gate. (Live 2026-06-11: two successful read_screens, then "I'm having
// trouble reading the screen content… you can manually navigate…?")
const FALSE_BLINDNESS_RE =
  /\b(trouble|can'?t|cannot|unable|not able|isn'?t (working|responding)|having (trouble|issues|difficulty))\b[^.?!]{0,60}\b(read|see|view|access)[^.?!]{0,30}\b(screen|guide|display|content)/i

// First-person claims of an ON-SCREEN act (highlighting/pointing/clicking/typing/
// opening). A final saying one of these while NO screen tool succeeded this turn is
// fabrication — the user sees nothing. (Live 2026-06-11 turn 2: "I'm highlighting
// the Appearance section in the sidebar" — zero guide_user calls; it slipped every
// gate because the utterance "okay, system settings is open" matched no teach/guide
// regex. This gate is utterance-independent: it keys on the CLAIM + the ledger.)
const CLAIMS_SCREEN_ACTION_RE =
  /\b(i('?m| am|'?ve| have)?\s*(just\s+|now\s+|re-?)*(highlight(ed|ing)|point(ed|ing)|click(ed|ing)|press(ed|ing)|typ(ed|ing)))\b/i

/** Did any screen tool actually succeed this turn? Grounded on result text, not
 *  call presence — a failed guide_user must not license an "I'm highlighting". */
function screenActSucceeded(calls: VerifyToolCall[]): boolean {
  return calls.some((c) => {
    const r = String((c as any)?.result ?? "")
    if (c.name === "guide_user") return r.startsWith("Pointing at")
    if (c.name === "click_element") return r.startsWith("Clicked")
    if (c.name === "type_text") return r.startsWith("Typed into")
    return false
  })
}

export const PROMISSORY_RE =
  /\b(one (moment|sec(ond)?)|just a (moment|sec(ond)?)|hold on|give me a (moment|sec(ond)?)|let me (check|look|see|pull|get)|i('?ll| will) (now )?(check|look|take a look|get back to you|pull|find out|create|send|schedule|add|set|put|make|book|draft|guide|show|walk you|do (that|it))|i('?m| am) (going to|about to)|i('?ve| have) (just |already )?(started|begun)|i('?m| am) (now )?(researching|working on|looking into)|checking now|looking (into|at) (it|that|this|your|the)\b|starting (that|this|it) now)\b/i

export interface VerifyResult {
  ok: boolean
  concern?: string
  /** A grounded replacement the agent SHOULD say, derived from the ledger alone
   *  (e.g. "it's actually from Temu"). Empty when ok, or when none can be derived. */
  correction?: string
  /** 'write' if a destructive tool ran this turn (caller blocks before speaking);
   *  'read' otherwise (answer already streamed live → verify in overlap). */
  severity: "read" | "write"
  /** True when the flag demands ACTION (call tools, keep guiding) rather than a fact
   *  correction — the loop gives the model one retry round. A text-only replacement
   *  can't satisfy these, and hedging with the raw concern leaked internal
   *  instructions straight into TTS (2026-06-10 wallpaper session). */
  retryable?: boolean
}

export interface VerifierDeps {
  llm: { complete: (body: any) => Promise<{ text: string }> }
  isDestructive?: (call: VerifyToolCall) => boolean
  maxTokens?: number
}

const SYSTEM =
  "You are a grounding checker for a voice assistant. You are given the user's request, the assistant's tool calls WITH their results/errors, and the exact words the assistant is about to speak. " +
  "DEFAULT TO ok:true. Only return ok:false when you are CERTAIN of a real problem: the assistant claims it DID an action (sent/deleted/created/connected/booked) but no successful tool call performed it, OR a specific stated detail DIRECTLY CONTRADICTS a value present in the results (e.g. says 'from Alice' when the result clearly shows 'from Bob'). " +
  "Do NOT flag merely because evidence is missing — the tool results shown to you may be TRUNCATED or partial, so a detail you can't find might still be there. If the results are truncated, summarized, or you cannot tell, return ok:true. A false alarm is worse than a missed nuance: when unsure, ok:true. " +
  "Judge ONLY against the tool results, never your own knowledge. " +
  'Return STRICT JSON only: {"ok": true|false, "concern": "<short reason, empty if ok>", "correction": "<what the assistant should say given ONLY the tool results; empty if ok or you cannot tell>"}.'

/** Build the grounding verifier. (Name kept for back-compat; it now verifies ALL
 *  tool turns, not just destructive ones — destructiveness only tiers latency.) */
export function buildDestructiveVerifier(deps: VerifierDeps) {
  const isDestructive = deps.isDestructive ?? isDestructiveCall
  return {
    async verify(opts: { utterance: string; finalText: string; toolCalls: VerifyToolCall[] }): Promise<VerifyResult> {
      const calls = opts.toolCalls ?? []
      const severity: "read" | "write" = calls.some((c) => isDestructive(c)) ? "write" : "read"
      const finalText = String(opts.finalText ?? "")

      // FREE deterministic pre-check: the agent ended the turn with a PROMISE ("one moment",
      // "I'll check…") instead of a result. That's only legitimate when the work was actually
      // handed off to the background lane. Otherwise force a self-correct round so it DOES the
      // work now instead of hanging up on a promise (2026-06-10: "I can check your calendar.
      // One moment." — turn over, nothing checked).
      const handedOff = calls.some((c) => c.name === "spawn_background_task" || c.name === "run_subtask")
      // An answer that ENDS with a question is an offer awaiting the user's call ("…want me to
      // archive the rest?") — a valid end-state, not an abandoned promise. Don't flag those.
      const endsAsQuestion = finalText.trim().endsWith("?")
      if (!handedOff && !endsAsQuestion && finalText.length < 240 && PROMISSORY_RE.test(finalText)) {
        return {
          ok: false,
          severity,
          retryable: true,
          concern:
            "you ended with a promise instead of the result — actually do the task NOW (call the tools you need) and answer with what you found, or state plainly what's blocking you",
        }
      }

      // PHANTOM SCREEN-ACTION gate (every turn, utterance-independent): a final
      // claiming "I'm highlighting / I clicked / I'm typing…" while no screen tool
      // SUCCEEDED is a fabrication the user can see through instantly — nothing is
      // on their screen. Applies even to question-finals.
      if (CLAIMS_SCREEN_ACTION_RE.test(finalText) && !screenActSucceeded(calls)) {
        return {
          ok: false,
          severity,
          retryable: true,
          correction: "Say 'continue' and I'll actually do it on your screen.",
          concern:
            "you CLAIMED an on-screen action (highlighting/clicking/typing) but no screen tool succeeded this turn — " +
            "the user sees NOTHING. Actually do it now: read_screen, then guide_user (to point) or click_element (to act) by NUMBER",
        }
      }

      // DO-MODE GATE (deterministic): the user said "switch/turn/change X" — they
      // want it DONE. A turn that only POINTS, or that ends by telling the USER to
      // click, is outsourcing the exact action it has click_element for (live
      // 2026-06-11: "Switch my Mac to light mode" → perfect point at Appearance →
      // "I'm highlighting General — please click on that to proceed"). Exempt when
      // acting is unavailable (HUD down) or when a confirm-pause is in progress.
      const teachingAskEarly = TEACHING_RE.test(opts.utterance ?? "")
      if (!teachingAskEarly && DO_ASK_RE.test(opts.utterance ?? "")) {
        const resultOf = (c: VerifyToolCall) => String((c as any)?.result ?? "")
        const actUnavailable = calls.some((c) => /isn'?t available/i.test(resultOf(c)))
        const acted = calls.some(
          (c) =>
            (c.name === "click_element" && resultOf(c).startsWith("Clicked")) ||
            (c.name === "type_text" && resultOf(c).startsWith("Typed into")),
        )
        const confirmPause = calls.some((c) => /needs_confirm|STOP —/.test(resultOf(c)))
        const pointedInstead = calls.some((c) => c.name === "guide_user" && resultOf(c).startsWith("Pointing at"))
        if (!actUnavailable && !acted && !confirmPause && (pointedInstead || TELLS_USER_TO_ACT_RE.test(finalText))) {
          return {
            ok: false,
            severity,
            retryable: true,
            correction: "Say 'continue' and I'll do it for you right now.",
            concern:
              "the user asked you to DO this — don't hand it back to them. Use click_element({element: N}) yourself " +
              "(read_screen first if needed, type_text for fields), step by step, until the change is done and verified",
          }
        }
        // FALSE-DONE check: claiming completion while the LAST act reported the
        // screen did NOT change (live 2026-06-11: two ineffective clicks → "You're
        // all set. Your Mac is in Light mode." — it wasn't).
        if (acted && /\b(all set|you'?re set|it'?s (done|switched|changed|on|off)|switched (to|your)|now (in|on) )\b/i.test(finalText)) {
          const lastAct = [...calls].reverse().find((c) => c.name === "click_element" || c.name === "type_text")
          if (lastAct && /did NOT change/i.test(resultOf(lastAct))) {
            return {
              ok: false,
              severity,
              retryable: true,
              correction: "Hmm, that click didn't take — say 'continue' and I'll try a different way.",
              concern:
                "your LAST click did not change the screen — the task is NOT done. Do not claim it is. " +
                "read_screen and act on the correct element, or tell the user honestly what's blocking",
            }
          }
        }
      }

      // WALKTHROUGH GATE (deterministic): during a TEACHING ask ("teach/walk me
      // through/how do I…"), pointing at a step and then ENDING the turn strands the
      // user — every step must be followed by wait_for_screen so the lesson advances
      // when the user acts (live failure 2026-06-10: perfect point, perfect sync
      // line, turn over). Single "show me where X is" asks are exempt — there,
      // pointing IS the complete answer.
      const teachingAsk = TEACHING_RE.test(opts.utterance ?? "")
      const guideAsk = GUIDE_RE.test(opts.utterance ?? "")
      if (teachingAsk || guideAsk) {
        const names = calls.map((c) => c.name)
        const guides = calls.filter((c) => c.name === "guide_user")
        // The on-screen guide being genuinely unavailable (no HUD / no AX) makes
        // verbal guidance the CORRECT outcome — never gate that.
        const guideUnavailable = guides.some((c) => /isn'?t available/i.test(String((c as any)?.result ?? "")))
        // LOOK BEFORE POINTING — checked even on question-finals: pointing from
        // memory picks wrong panes (live: "Appearance" for a WALLPAPER ask, then
        // "can you confirm you clicked Appearance?" — the question exemption let
        // the misdirection stand). read_screen must precede the first guide_user.
        const firstGuide = names.indexOf("guide_user")
        const lookedFirst = firstGuide >= 0 && names.slice(0, firstGuide).includes("read_screen")
        const lookedAtAll = names.includes("read_screen")
        // Look-first is TEACHING-only: a re-highlight ("highlight it again") may
        // legitimately point straight at the remembered target without re-reading.
        if (teachingAsk && !guideUnavailable && firstGuide >= 0 && !lookedFirst) {
          return {
            ok: false,
            severity,
            retryable: true,
            correction: "Say 'continue' and I'll take a fresh look at your screen and point you to the right spot.",
            concern:
              "you pointed WITHOUT looking first — call read_screen now, check the NUMBERED inventory for the element " +
              "that matches the user's actual goal, then point at it by NUMBER (guide_user({element: N})) and continue the walkthrough",
          }
        }
        // NEVER-LOOKED gate — applies even to question-finals: a clarifying question
        // is only legitimate AFTER looking (looking is free and silent). Live escape:
        // zero tools + "where did you see the Appearance section?" — the model
        // offloading its own job to the user.
        if (!guideUnavailable && firstGuide < 0 && !lookedAtAll) {
          return {
            ok: false,
            severity,
            retryable: true,
            correction: "Say 'continue' and I'll look at your screen and walk you through it step by step.",
            concern:
              "you haven't even looked at the screen — call read_screen first, then point at the element matching the " +
              "user's goal by NUMBER (guide_user({element: N})) and walk them through it step by step",
          }
        }
        // FALSE-BLINDNESS gate — applies even to question-finals: claiming "I can't
        // read the screen" when read_screen SUCCEEDED this very turn is a lie that
        // contradicts the model's own ledger. (Guide tools are LOCAL_TOOLS, so the
        // LLM groundedness check never runs on these turns — this must be here.)
        const sawScreen = calls.some(
          (c) =>
            (c.name === "read_screen" && String((c as any)?.result ?? "").startsWith("CURRENT SCREEN")) ||
            (c.name === "guide_user" && String((c as any)?.result ?? "").startsWith("Pointing at")),
        )
        if (!guideUnavailable && sawScreen && FALSE_BLINDNESS_RE.test(finalText)) {
          return {
            ok: false,
            severity,
            retryable: true,
            correction: "Say 'continue' and I'll point you to the right spot on your screen.",
            concern:
              "you CLAIMED you can't read the screen, but read_screen SUCCEEDED this turn — you have the numbered " +
              "inventory. Point at the element matching the user's goal (guide_user({element: N})); if nothing matches, " +
              "point at the sidebar section that leads to it. Never claim blindness you don't have",
          }
        }
        // SCREEN-OFFLOAD gate — applies even to question-finals: asking the USER to
        // describe their own screen is the model offloading the one job it has eyes
        // for (live escapes: "where did you see the Appearance section?", "can you
        // tell me what app you're in?" — both after a working read_screen existed).
        if (!guideUnavailable && SCREEN_OFFLOAD_RE.test(finalText)) {
          return {
            ok: false,
            severity,
            retryable: true,
            correction: "Say 'continue' and I'll look at your screen myself and point you to the right spot.",
            concern:
              "you asked the USER what's on their screen — YOU can see it. Call read_screen yourself; if the goal item " +
              "isn't in the inventory, point at the sidebar/section that leads to it, by NUMBER (guide_user({element: N}))",
          }
        }
        if (!guideUnavailable && !endsAsQuestion) {
          const lastGuide = names.lastIndexOf("guide_user")
          const pointed = lastGuide >= 0 && String((calls[lastGuide] as any)?.result ?? "").startsWith("Pointing at")
          // "Watched" = a wait was attempted after the FIRST point (not the last):
          // a toggle-step ending legitimately goes wait(instant-hit) → point at the
          // toggle → end turn — the between-turns watcher takes it from there.
          const watched = firstGuide >= 0 && names.slice(firstGuide + 1).includes("wait_for_screen")
          if (!pointed) {
            // Described from memory with ZERO successful pointing (live failure:
            // "find and click on Appearance" for a WALLPAPER ask — wrong pane, no
            // guide_user at all). Make it look, then point. The correction matters:
            // without one, a failed retry spoke the bare hedge ("Hmm — I'm not fully
            // sure that worked") as the ENTIRE answer to a teach ask (live 2026-06-11).
            return {
              ok: false,
              severity,
              retryable: true,
              correction: "Say 'continue' and I'll point you to it on your screen, step by step.",
              concern:
                "this is a guided walkthrough — don't describe steps from memory. Call read_screen to see what's " +
                "actually on screen, then guide_user to POINT at the first element, speak that one step, and " +
                "wait_for_screen for what appears after the user does it",
            }
          }
          // Wait-after-point is TEACHING-only: for a plain "show me where X" the
          // pointing IS the answer. A wait that TIMED OUT still counts as watched —
          // ending the turn with a gentle check-in is now legitimate (the lesson
          // manager keeps the highlight up and auto-resumes when the user acts).
          if (teachingAsk && !watched) {
            return {
              ok: false,
              severity,
              retryable: true,
              concern:
                "the walkthrough isn't finished — you pointed at a step but never watched for the user to complete it. " +
                "Call wait_for_screen with the element that appears once they've done this step, then keep guiding in this same turn",
            }
          }
        }
      }

      // A run that touched only confined scratch/plan tools (or no tools) makes no
      // external/factual claim worth grounding → ok, no LLM call.
      const external = calls.filter((c) => !LOCAL_TOOLS.has(c.name))
      if (external.length === 0) return { ok: true, severity }

      // FREE deterministic pre-check (no LLM, ~0ms): a WRITE tool ERRORED and was
      // NOT retried successfully later — the agent must not claim success over it.
      // isDestructive now classifies by first-verb, so QUICK_ADD/BOOK count too.
      // Reads that error (an honest "couldn't find it") are excluded by isDestructive.
      const erroredWrite = external.find((c, i) => {
        if (!isDestructive(c) || !callErrored(c)) return false
        const nm = effectiveName(c)
        // a later successful call of the same tool = recovered → don't flag.
        return !external.slice(i + 1).some((d) => effectiveName(d) === nm && !callErrored(d))
      })
      if (erroredWrite) {
        return {
          ok: false,
          severity: "write",
          concern: `${effectiveName(erroredWrite)} did not succeed (${erroredWrite.error ?? "the result reported a failure"})`,
        }
      }

      // General LLM groundedness over the FULL ledger — reads included, so a
      // misread ("your last email is X") is caught, not only write failures.
      const ledger = external
        .map(
          (c) =>
            `tool=${effectiveName(c)}${isDestructive(c) ? " [write]" : " [read]"} ${
              c.error ? `ERROR=${c.error}` : `result=${JSON.stringify(c.result ?? null).slice(0, 3000)}`
            }`,
        )
        .join("\n")
      try {
        const resp = await deps.llm.complete({
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: `User asked: "${opts.utterance}"\nTool calls:\n${ledger}\nAssistant is about to say: "${finalText}"` },
          ],
          max_tokens: deps.maxTokens ?? 160,
          temperature: 0,
        })
        const parsed = JSON.parse(resp.text)
        return {
          ok: parsed.ok !== false,
          concern: parsed.concern || undefined,
          correction: parsed.correction || undefined,
          severity,
        }
      } catch {
        // Verifier itself failed — do NOT block a real reply on our own error.
        return { ok: true, severity }
      }
    },
  }
}

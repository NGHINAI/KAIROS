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
  // open_app launches a macOS app by name (argv-only `open -a`) — benign, reversible.
  // run_applescript / run_shell self-guard (destructive patterns hard-refused inside
  // the tool); the user opted into a hands-on assistant with no per-action prompts,
  // so they're not approval-gated. click_element actuates a single AX press.
  "guide_user", "open_app", "run_applescript", "run_shell", "click_element",
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
export const PROMISSORY_RE =
  /\b(one (moment|sec(ond)?)|just a (moment|sec(ond)?)|hold on|give me a (moment|sec(ond)?)|let me (check|look|see|pull|get)|i('?ll| will) (now )?(check|look|take a look|get back to you|pull|find out|create|send|schedule|add|set|put|make|book|draft|do (that|it))|i('?m| am) (going to|about to)|i('?ve| have) (just |already )?(started|begun)|i('?m| am) (now )?(researching|working on|looking into)|checking now|looking (into|at) (it|that|this|your|the)\b|starting (that|this|it) now)\b/i

export interface VerifyResult {
  ok: boolean
  concern?: string
  /** A grounded replacement the agent SHOULD say, derived from the ledger alone
   *  (e.g. "it's actually from Temu"). Empty when ok, or when none can be derived. */
  correction?: string
  /** 'write' if a destructive tool ran this turn (caller blocks before speaking);
   *  'read' otherwise (answer already streamed live → verify in overlap). */
  severity: "read" | "write"
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
          concern:
            "you ended with a promise instead of the result — actually do the task NOW (call the tools you need) and answer with what you found, or state plainly what's blocking you",
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

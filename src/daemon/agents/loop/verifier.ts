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

// ── Structural read-vs-write classification (tool NAME only) ──────────────────
// This is NOT a regex on the user's request and never decides the verdict — it
// only TIERS latency: a turn that ran a write tool is "irreversible" and the
// caller holds the spoken claim until verified (block); a read-only turn already
// streamed live, so it's verified in overlap. The LLM judges groundedness on
// EVERY tool turn regardless, so a mis-tier only changes timing, never safety.
const DESTRUCTIVE_RE =
  /(SEND|DELETE|REMOVE|ARCHIVE|CREATE|UPDATE|EDIT|POST|PUT|PATCH|PAY|CHARGE|CANCEL|ASSIGN|INVITE|MERGE|CLOSE|MOVE|TRASH|UNSUBSCRIBE)/i
const DESTRUCTIVE_NAMES = new Set(["connect_service", "disconnect_service", "setup_for"])

// Local/scratch tools touch only the agent's private workdir or in-memory plan —
// never an external/irreversible system, and never a user-facing factual claim
// worth a grounding LLM call. A run of ONLY these short-circuits to ok.
const LOCAL_TOOLS = new Set(["read_file", "list_dir", "write_file", "edit_file", "grep", "glob", "update_plan", "run_shell"])

/** The real action name — unwrapping execute_tool's wrapped tool_name. */
function effectiveName(call: VerifyToolCall): string {
  if (call.name === "execute_tool") return String(call.args?.tool_name ?? "")
  return call.name
}

/** Did this call touch external, irreversible state? Structural — tool name only.
 *  Used to tier block-vs-overlap latency, NEVER as the groundedness verdict. */
export function isDestructiveCall(call: VerifyToolCall): boolean {
  if (LOCAL_TOOLS.has(call.name)) return false // confined scratch/plan tools — never external
  const name = effectiveName(call)
  if (DESTRUCTIVE_NAMES.has(call.name) || DESTRUCTIVE_NAMES.has(name)) return true
  // LIST/GET/SEARCH/FETCH/READ are reads even if the toolkit name is long.
  if (/(_LIST|_GET|_SEARCH|_FETCH|_READ|LIST_|GET_|SEARCH_|FIND_)/i.test(name)) return false
  return DESTRUCTIVE_RE.test(name)
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
      const severity: "read" | "write" = calls.some(isDestructive) ? "write" : "read"
      const finalText = String(opts.finalText ?? "")

      // A run that touched only confined scratch/plan tools (or no tools) makes no
      // external/factual claim worth grounding → ok, no LLM call.
      const external = calls.filter((c) => !LOCAL_TOOLS.has(c.name))
      if (external.length === 0) return { ok: true, severity }

      // FREE deterministic pre-check (no LLM, ~0ms): a write tool ERRORED or
      // returned failure. The agent must not claim success over a failed write.
      // Highest-value, most dangerous catch — zero latency.
      const erroredWrite = external.find((c) => isDestructive(c) && callErrored(c))
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
              c.error ? `ERROR=${c.error}` : `result=${JSON.stringify(c.result ?? null).slice(0, 2000)}`
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

# 02 — The intermediate proxy (ship without revealing Codex/OpenRouter)

**Status:** design locked. Local-first now → hosted later, zero app change.

User requirement: *"our own intermediate proxy server, so that even if we ship
this app, nobody knows that we are using Codex in the background. We need to make
a key as well. We don't want a single chat and everything, and we will use
OpenRouter with the Codex."*

The proxy is an **OpenAI-compatible facade** that Codex talks to. It hides the
entire provider chain: the shipped app's codex config points at
`https://brain.<ourdomain>/v1`; the facade forwards to OpenRouter with OUR
server-side dedicated key; nothing in the bundle, traffic, config, or logs names
OpenRouter or the real model slugs. Written ONCE as a portable Web-Fetch handler,
it runs as a localhost Bun server **now** and deploys as a Cloudflare Worker
**later** with no app change — only the `base_url` in the generated config differs.

Prior art (HeyClicky, shipped binary): its codex config hardcodes
`[model_providers.clicky] base_url=<CLICKY_WORKER_BASE_URL> env_key="OPENAI_API_KEY"
wire_api="responses" trust_level="trusted" hide_full_access_warning=true
history.persistence="save-all"`; the Worker fans out to OpenRouter + Anthropic
upstream ("Worker /v2/chat upstream OpenRouter"); the app only ever holds a
**backend-minted, rotating per-install agent session token** (NOT a provider key),
injected into the codex child's `OPENAI_API_KEY` at spawn; identity/version/mode
ride `X-Clicky-*` headers; auth via Supabase + a token-minting RPC.

---

## 1. THE load-bearing constraint: Codex talks Responses, not chat

**codex 0.133.0 hard-rejects `wire_api="chat"` at config load:**
> *"`wire_api = "chat"` is no longer supported. How to fix: set `wire_api =
> "responses"` … `responses` is the only supported value, and it is the default
> when omitted."*

So the facade MUST present the **OpenAI Responses API** to Codex on its inbound
side — there is no shortcut where Codex speaks `chat/completions` directly to
OpenRouter.

Meanwhile **OpenRouter's GA path is `chat/completions`**; its `POST /v1/responses`
is **beta + stateless**, and KAIROS already calls OpenRouter via the GA streaming
chat path (`openRouterAdapter.ts:183` → `${baseUrl}/chat/completions`,
`stream: true`).

**⇒ Facade wire shape: Responses-IN (from Codex), chat/completions-OUT (to
OpenRouter).** A `Responses ↔ chat` streaming translator is the ONE nontrivial
piece; everything else is passthrough. Reasoning effort comes from the codex
turn/profile, not the wire (Codex carries it in the Responses request; we pass it
through where supported and drop it where the OR model can't honor it).

> Don't rely on OR's `/v1/responses` as the UPSTREAM (beta, breaking). Using
> chat/completions upstream means we own conversation-state assembly inside the
> translator — but Codex app-server manages thread history client-side and sends
> full input per turn, so the stateless OR path is fine; just never advertise
> stateful/`store` Responses semantics to Codex.

---

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/responses` | **Codex's only allowed wire.** Responses-in → chat-out translator. |
| `POST` | `/v1/chat/completions` | Passthrough streaming (for KAIROS's OWN fast tier later). |
| `GET` | `/v1/models` | Returns ONLY our aliases (`kairos-smart`, `kairos-deep`). |

### The Responses↔chat translator (`responsesToChat.ts`)
- **Inbound (Responses → chat):** map Responses `input` items + `instructions` →
  chat `messages`; map `tools` / `tool_choice` (near-identical shapes);
  `function_call` / `function_call_output` items → chat tool-call/tool messages.
- **Outbound (OR chat SSE → Responses SSE):** re-emit OR chat deltas as Responses
  events — `response.created`, `response.output_text.delta`,
  `response.function_call_arguments.delta`, `response.completed`.
- **Scope v1 to exactly the item types codex 0.133.0 emits.** Capture them with a
  logging passthrough during a real app-server turn BEFORE finalizing the
  translator (the Responses surface — reasoning items, web_search/file_search
  built-ins, multi-part input, images — is large; a text+function-tools-only
  translator may choke on shapes Codex sends). Pin behavior with **golden-file
  tests** against a recorded OR chat stream so an OR SSE-shape change is caught.

#### Prompt-cache plane (D15)

The durable persona/doctrine prefix (`buildSessionPrefix`, [09] §B.1/E) is the
stable head of every deep turn, but the translator is stateless and would
re-prefill it on each request — paying first-token latency AND input cost over
and over. FIX: **the translator marks the stable prefix cacheable** when the
model+provider supports it. On the inbound map (Responses → chat) it emits a
`cache_control` breakpoint (or relies on implicit prefix caching) at the
prefix/delta seam — the persona/doctrine messages are cacheable, the fresh
per-turn delta + history + utterance are NOT.

- The prefix/delta split **already exists** ([09] §B: durable doctrine vs
  volatile per-turn delta), so the cache boundary is free — the translator just
  needs to know where the stable head ends. Carry that boundary as an explicit
  marker on the inbound items (e.g. a sentinel between the doctrine block and the
  delta) so the translator never guesses.
- The persona (witty/sarcastic, onboarding-set via soul.md/SoulWizard/
  `KAIROS_PERSONA_TONE`, user-changeable) lives INSIDE this cacheable prefix
  ([14] §H3). KAIROS learning flows through the VOLATILE per-turn delta, NOT by
  rewriting the prefix — so the cache stays warm turn-over-turn. A persona change
  is a rare event (onboarding / user re-tune) handled as a NEW thread, which is
  the only time the cached head changes ([01] §G, [09] §E).
- Gate on capability: emit `cache_control` ONLY when `modelAliases.ts` records
  the real upstream slug as cache-capable; otherwise pass through unmarked (the
  alias map is the single place that knows the real provider's caching surface,
  and it stays server-side so no slug leaks). A model that can't honor caching
  must degrade silently, not error.
- This cuts first-token latency on deep turns AND input cost; the savings
  surface in metering (§5) as reduced billed input tokens per cached turn.

#### Version-bump contract fixture (C14)

The proxy sits between TWO translation layers — codex's JSON-RPC app-server
surface (inbound Responses items) and OpenRouter's chat SSE (upstream). A codex
minor bump can change the inbound Responses item shapes; an OR change can move
the SSE shape. The golden-file tests above pin the OUTBOUND side (recorded OR
chat stream). C14 pins the INBOUND side and **binds the two layers**:

- **Capture a real inbound `codex → Responses` item stream** during a live
  app-server turn (the same logging-passthrough capture used to scope the
  translator) and commit it as a **pinned fixture**.
- The **version-bump test replays that fixture through the translator** and
  asserts the produced chat-out messages/tools are unchanged — so bumping the
  pinned codex ([01] §5) is a deterministic, offline contract check, not a
  discover-at-ship-time surprise. Pair it with the outbound OR golden file so a
  single test run validates BOTH translation directions end-to-end.
- This is the fixture task tracked in [13] (A1); treat a codex/OR bump as a
  required pass of this contract test before the bump lands (see §10).

---

## 3. Model aliasing (swap models without an app update)

- The generated `config.toml` uses a single alias (e.g. `model = "kairos-smart"`,
  or one alias for both tiers since smart/deep differ only by per-turn effort —
  see [01] §1).
- The facade keeps a **server-side map**:
  `{ kairos-smart → <real OR slug>, kairos-deep → <real OR slug> }`.
- `GET /v1/models` returns ONLY the alias ids.
- Swapping the real upstream = edit the server-side map; **zero app update**.
- **A real OR slug must NEVER appear in the bundle, config, traffic, or logs.**

---

## 4. Per-install auth (copy HeyClicky exactly — no shared provider key)

- The app obtains a **per-user/device token** at onboarding (Supabase-auth style,
  or a licence key). The daemon injects THAT token into the codex child's
  `OPENAI_API_KEY` env at spawn — `env_key = "KAIROS_BRAIN_KEY"` carries the
  TOKEN, **never a provider key**.
- The facade validates the token, attaches the real OpenRouter key **server-side**,
  and maps token → install for metering. **Revocation = kill one token**, not the
  fleet.
- Identity/version ride headers: `x-kairos-build`, `x-kairos-distinct-id`,
  `x-kairos-session-id`, `x-kairos-trace-id` (HeyClicky's `X-Clicky-*` analogs).

### Token model (decision: stable install token, server-side key swap)
Two options:
1. Inject a short-lived **rotating** provider-proxy token at process SPAWN
   (HeyClicky/openclicky pattern) — but a token that expires mid-session can't be
   refreshed without RESPAWN, so it needs respawn-on-401 + rotation.
2. **Inject a STABLE per-install token and do the short-lived real-key swap
   entirely server-side** — keeps the child's env constant, avoids mid-session
   respawn. **← preferred.**

Either way, on a 401 the daemon refreshes (HeyClicky: "agent session token rotated"
/ "retrying with refreshed Supabase token") and respawns only if forced.

### Loopback auth — bearer + Origin/Host allowlist (B8)

The local `Bun.serve` facade listens on `127.0.0.1`, but any other local process
(a malicious npm postinstall, a browser page via DNS-rebind, another app) can
reach `127.0.0.1` too. Loopback is **not** an auth boundary. FIX: require a
bearer on EVERY local entry point — independent of the migration, applied to the
shared server (see [08], the `wrapApi` server task):

- **Bearer on `/mcp` AND the existing `/v1/*` + WS command paths.** The facade
  and the KAIROS MCP mount ([08]) and the daemon's WS control channel all require
  `Authorization: Bearer <KAIROS_MCP_TOKEN>` (a per-boot local token, distinct
  from the per-install `KAIROS_BRAIN_KEY` proxy token of §4). Compare with
  **`crypto.timingSafeEqual`** (constant-time; never `===`) to avoid a timing
  oracle on the token.
- **Origin/Host allowlist.** Reject requests whose `Origin`/`Host` are not on a
  fixed allowlist (`127.0.0.1:<port>` / `localhost:<port>`), which kills
  DNS-rebinding from a browser tab even if it somehow learned the token.
- The codex child gets `KAIROS_MCP_TOKEN` in its minimal allowlisted spawn env
  (B6, [01] §3) so it can reach the in-process `/mcp` mount; nothing else on the
  box has it. Keep the bearer in env, not on-disk where avoidable (B11).

> This is the local analog of the hosted facade's per-install token (§4): §4
> hides the provider chain over the network; B8 stops *local* processes from
> hijacking the loopback brain/MCP/WS surface. Both must hold.

---

## 5. Metering + budgets + kill-switch (server-side authority)

- Parse OR usage from the upstream chat stream → write a **per-install/per-token
  counter** (KV/D1 hosted; the existing `usageMeter.ts` / `costTracker.ts`
  locally). Add task_type `codex_smart` / `codex_deep` + a per-install/token
  dimension so facade metering mirrors local `llm_call_log`.
- **Enforce per-day / $ caps AT THE FACADE** — local code can't be trusted in a
  shipped app. This is the hard enforcement point [01] §F defers to.
- **Kill-switch + version gate:** require `x-kairos-build`; the facade can
  `426`/`403` old builds with a force-upgrade message, and flip the alias map
  instantly for incident response.
- **Logging:** per-token counters ONLY, **never request/response bodies.** A
  careless access log would leak both user content and the fact that OpenRouter /
  specific models are upstream — defeating the entire hiding goal. State this in
  the eventual privacy page.

---

## 5a. Upstream resilience (C13)

The proxy is the **single hop** to OpenRouter — if it forwards a transient
upstream failure raw, every Codex turn breaks. It must own retry/backoff/
circuit-break/degrade so a flaky provider never reads as a dead brain:

- **Classify the upstream failure.** Distinguish retryable from terminal:
  `429` (rate limit) and `5xx` / connection resets / read timeouts are retryable;
  `4xx` (bad request, `401` auth) are terminal and pass straight through (a
  `401` from upstream is a server-side key problem, surfaced as such — never
  exposing the provider).
- **Bounded server-side backoff, honor `Retry-After`.** On a retryable failure,
  retry inside the facade with capped exponential backoff (small bounded attempt
  count + a hard wall-clock ceiling so a deep turn never hangs indefinitely). If
  the upstream sends `Retry-After`, honor it as the floor of the wait. Backoff is
  **server-side**: the codex child sees one slow-but-eventually-succeeding
  request, not N retries, so its own turn timing stays clean. (Streaming caveat:
  retry is only safe BEFORE the first byte is forwarded downstream — once
  Responses SSE has started flowing to Codex, a mid-stream upstream drop cannot
  be transparently retried and becomes the transport error below.)
- **Circuit-break → graceful hedge.** After repeated failures within a window,
  open a short-lived circuit so the facade stops hammering a down provider and
  instead returns a clean, body-free **transport error** (a "provider's flaky,
  try again in a moment" hedge — no provider name, no slug). Surface it as the
  SAME class of transport error the conductor already hedges on, so the existing
  hedge/retry-or-apologize path handles it with no new client logic. The error
  carries no upstream identity (consistent with §5 logging + §7 hiding).
- Hosted vs local: identical handler (§6). Worker pre-warm/keep-alive for the
  hosted phase is **declined for now** ([14] "What we DECLINED") — note here,
  don't build.

---

## 6. Local-now → host-later (zero app change)

Write the facade ONCE as a Bun module exporting a standard Web-Fetch handler
(`(req: Request) => Response`, SSE via `ReadableStream`). Workers and Bun share
the Web Fetch/Streams API, so the SAME handler is portable.

- **Local (now):** run via `Bun.serve` on `127.0.0.1:<port>` (mirror
  `src/daemon/wrapApi/server.ts`'s routes map). The generated config's
  `base_url = http://127.0.0.1:<port>/v1`. A **dedicated OpenRouter key lives only
  in the facade** (never in the app) — this exercises the translator from day one
  instead of discovering wire bugs at ship time.
- **Hosted (later):** the SAME handler deploys as a Cloudflare Worker
  (`export default { fetch }`). `base_url = https://brain.<ourdomain>/v1`.

The ONLY thing that changes between local and hosted is the `base_url` written into
the generated config — env-driven exactly like openclicky's `CLICKY_AGENT_BASE_URL`:
a single `KAIROS_BRAIN_BASE_URL`
(dev = `http://127.0.0.1:<port>/v1`, ship = `https://brain.<ourdomain>/v1`).

> **Note (corrects the old draft):** "dev mode skips the proxy and points
> `base_url` straight at `https://openrouter.ai/api/v1`" is NOT safe, because
> OR's `/v1/responses` is beta and Codex requires `wire_api=responses`. **Run the
> localhost facade even in dev** (it's the same code you ship) with a dedicated OR
> key server-side. Create that dedicated key (07.2) and store it ONLY in the facade.

---

## 7. Why nobody inspecting the app can tell Codex/OpenRouter is underneath

| Inspection vector | What they see | What's hidden |
|---|---|---|
| App bundle / config.toml | `base_url = https://brain.<ourdomain>/v1`, `model = "kairos-smart"`, `env_key=KAIROS_BRAIN_KEY` (a token) | OpenRouter URL, real model slugs, real provider key. |
| Network traffic from the app | TLS to `brain.<ourdomain>` only | The OR fan-out happens server-side. |
| `GET /v1/models` | Only `kairos-smart` / `kairos-deep` aliases | Real slugs. |
| Captured token | A per-install token (revocable) | The provider key never leaves the facade. |
| Logs | Per-token counters only | No bodies, no provider names. |

The only on-disk hint that codex itself is involved is the vendored `codex` binary
([01] §5) — that's unavoidable, but the brand/provider chain behind it is fully
opaque. (If even the binary's presence must be obscured, the arch-shim dir can be
renamed neutrally — cosmetic, not load-bearing.)

---

## 8. Codex spawn config block (what the facade consumes)

Generated into the isolated `CODEX_HOME` ([01] §B):
```toml
model_provider = "kairos"
[model_providers.kairos]
name       = "KAIROS"
base_url   = "<KAIROS_BRAIN_BASE_URL>"   # dev: http://127.0.0.1:<port>/v1 ; ship: https://brain.<domain>/v1
env_key    = "KAIROS_BRAIN_KEY"          # the per-install TOKEN, never a provider key
wire_api   = "responses"                 # mandatory — codex 0.133 rejects "chat"
trust_level            = "trusted"
hide_full_access_warning = true

[model_providers.kairos.http_headers]    # build/version gate + tracing
x-kairos-build = "<build id>"
```
(`preferred_auth_method = "apikey"` — no ChatGPT account handshake. Confirm whether
the child needs ANY `OPENAI_API_KEY` value to initialize the apikey path; if so, it
is the proxy token, never a provider key.)

---

## 9. Non-goals (for now)

- No server-side conversation storage; threads live on-device in CODEX_HOME
  ([01] §8 — KAIROS-authoritative replay).
- No proxying of the daemon's own fast-tier calls yet (can adopt later for the same
  hiding/metering benefits — the portable handler makes it a single migration once
  built).

---

## 10. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `wire_api="chat"` hard-rejected → Responses↔chat translator is mandatory | Golden-file tests vs recorded OR SSE; capture real codex Responses items before finalizing scope. |
| OR `/v1/responses` is beta + stateless | Use chat/completions UPSTREAM; never advertise stateful Responses to Codex. |
| Responses surface is large; minimal translator may choke | Scope v1 to the exact item types codex 0.133 emits; logging passthrough during a live turn. |
| Version drift (codex app-server JSON-RPC + Responses items change across minors) | Pin codex ([01] §5); treat a bump as a breaking-change test pass for BOTH the JSON-RPC adapter and the translator. **C14:** a pinned inbound codex→Responses fixture + the outbound OR golden file replay through the translator on every bump (§ translator, [13] A1). |
| Token rotation race (spawn-time key can't refresh mid-session) | Prefer stable install token + server-side key swap (constant child env); else respawn-on-401. |
| Privacy/log leak reveals provider chain | Counters only, never bodies; no provider names in logs. |
| Upstream `429`/`5xx`/outage on the single hop breaks every turn (C13) | Facade classifies retryable vs terminal, bounded server-side backoff honoring `Retry-After`, circuit-break to a body-free transport-error hedge the conductor already retries on (§5a). |
| Local process hijacks loopback brain/MCP/WS (B8) | Bearer (`KAIROS_MCP_TOKEN`, `timingSafeEqual`) on `/mcp` + `/v1/*` + WS, plus an Origin/Host allowlist vs DNS-rebind (§4 loopback auth). |
| `danger-full-access` codex bypasses our gates | Verifier + MCP destructive-confirm run independently ([01] §D); write/irreversible tools keep their own approval gating. **Default sandbox is `workspace-write`, not `danger-full-access`** ([14] B7) — full-access is interactive-opt-in only. |

---

## 11. Implementation sketch (file-level)

| File | Change |
|---|---|
| `src/daemon/brainProxy/facade.ts` (NEW dir) | `export default { fetch }` portable handler (Bun + Worker). Routes `/v1/responses`, `/v1/chat/completions`, `/v1/models`. |
| `src/daemon/brainProxy/responsesToChat.ts` (NEW) | The Responses↔chat streaming translator (the only nontrivial code). Marks the stable persona/doctrine prefix cacheable at the prefix/delta seam when the alias is cache-capable (D15). |
| `src/daemon/brainProxy/modelAliases.ts` (NEW) | `kairos-smart`/`kairos-deep` → OR slugs; backs `GET /v1/models`. Records per-slug cache capability for D15. |
| `src/daemon/brainProxy/upstream.ts` (NEW) | C13: classify 429/5xx vs terminal, bounded server-side backoff honoring `Retry-After`, circuit-breaker → body-free transport-error hedge. Wraps the OR client below. |
| `src/daemon/brainProxy/auth.ts` (NEW) | Per-install token validate + server-side provider-key swap; **plus** the loopback bearer (`KAIROS_MCP_TOKEN`, `timingSafeEqual`) + Origin/Host allowlist for `/mcp` + `/v1/*` + WS (B8). |
| `src/daemon/brainProxy/metering.ts` (NEW) | Per-token counters, budget/kill-switch, `x-kairos-build` gate. |
| `tests/brainProxy/translatorContract.fixture` (NEW) | C14: pinned inbound codex→Responses item stream replayed through the translator alongside the outbound OR golden file; the version-bump contract test ([13] A1). |
| `src/daemon/wrapApi/server.ts` | Extract the `Bun.serve` routes pattern into a reusable handler so the facade runs as a localhost route now AND exports the identical fetch handler for a Worker later. Enforce the B8 bearer + Origin/Host allowlist on `/mcp` + `/v1/*` + WS at this shared seam. |
| `src/daemon/wrapApi/adapters/openRouterAdapter.ts` | Reuse as the facade's UPSTREAM client (already streams `${baseUrl}/chat/completions`); factor SSE parsing so the translator wraps the same delta stream. |
| `src/daemon/llm/usageMeter.ts` | Add `codex_smart`/`codex_deep` task_type + per-install/token dimension; wire budget caps to the facade enforcement point. |

---

## 12. Open questions (tracked in 07)

- Which real OR slugs back `kairos-smart` / `kairos-deep`, and do they behave under
  the facade's chat/completions with tool calls + reasoning? (07.1 matrix.)
- Confirm the **new dedicated** OR key (`KAIROS_BRAIN_KEY`), separate from the
  daemon key. (07.2)
- Auth substrate: reuse the CertusAI Supabase project for the token table +
  minting RPC, or stand up dedicated KAIROS auth?
- Hosting target for ship: Cloudflare Worker (HeyClicky-proven, KV/D1 for
  tokens+counters) vs a Bun service on Fly/Railway — token storage (KV vs Supabase)
  should be chosen before metering is built. The portable fetch-handler keeps this
  deferrable.
- Installer size strategy ([01] §5) interacts with whether KAIROS ships as a
  Swift/Electron `.app` (vendored binaries in `Contents/Resources`) or a separately
  installed Bun daemon (daemon-relative `vendor/` dir).

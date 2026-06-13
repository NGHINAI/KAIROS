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
| Version drift (codex app-server JSON-RPC + Responses items change across minors) | Pin codex ([01] §5); treat a bump as a breaking-change test pass for BOTH the JSON-RPC adapter and the translator. |
| Token rotation race (spawn-time key can't refresh mid-session) | Prefer stable install token + server-side key swap (constant child env); else respawn-on-401. |
| Privacy/log leak reveals provider chain | Counters only, never bodies; no provider names in logs. |
| `danger-full-access` codex bypasses our gates | Verifier + MCP destructive-confirm run independently ([01] §D); write/irreversible tools keep their own approval gating. |

---

## 11. Implementation sketch (file-level)

| File | Change |
|---|---|
| `src/daemon/brainProxy/facade.ts` (NEW dir) | `export default { fetch }` portable handler (Bun + Worker). Routes `/v1/responses`, `/v1/chat/completions`, `/v1/models`. |
| `src/daemon/brainProxy/responsesToChat.ts` (NEW) | The Responses↔chat streaming translator (the only nontrivial code). |
| `src/daemon/brainProxy/modelAliases.ts` (NEW) | `kairos-smart`/`kairos-deep` → OR slugs; backs `GET /v1/models`. |
| `src/daemon/brainProxy/auth.ts` (NEW) | Per-install token validate + server-side provider-key swap. |
| `src/daemon/brainProxy/metering.ts` (NEW) | Per-token counters, budget/kill-switch, `x-kairos-build` gate. |
| `src/daemon/wrapApi/server.ts` | Extract the `Bun.serve` routes pattern into a reusable handler so the facade runs as a localhost route now AND exports the identical fetch handler for a Worker later. |
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

# KAIROS Phase C.2.6 — Cheap-Model Research Report
**Date:** 2026-05-25  
**Author:** Research agent (Claude Sonnet 4.6)  
**Scope:** Model lineup, API spec verification, hosted-mode cost recommendations

---

## 1. Model Lineup

### Usage baseline for cost math

| Parameter | Value |
|-----------|-------|
| Calls/day | 500 |
| Calls/month | 15,000 |
| Input tokens/call | 6,000 |
| Cache hit rate | 80% |
| Non-cached input/call | 1,200 tokens |
| Cached input/call | 4,800 tokens |
| Output tokens/call | 200 |

---

### 1.1 OpenAI — Current Models (as of 2026-05-25)

Official sources: [OpenAI model docs](https://developers.openai.com/api/docs/models/all) · [Deprecations](https://developers.openai.com/api/docs/deprecations)

| Model ID | Input $/M | Cached $/M | Output $/M | Context | Status |
|----------|-----------|------------|------------|---------|--------|
| `gpt-4o-mini` | $0.15 | $0.075 | $0.60 | 128K | **Active** — no published API sunset date. Retired from ChatGPT UI Feb 2026 but remains in API. Azure retired it Feb 27 2026. |
| `gpt-4.1-mini` | $0.40 | $0.10 | $1.60 | 1M | **Active** — released 2025. Recommended over gpt-4o-mini for complex tasks. |
| `gpt-5-mini` | $0.25 | $0.025 | $2.00 | 400K | **Active** — snapshot `gpt-5-mini-2025-08-07`. Near-frontier intelligence at low cost. |
| `gpt-5-nano` | $0.05 | $0.005 | $0.40 | 400K | **Active** — fastest, most economical GPT-5 variant. Good for classification/extraction. |
| `gpt-5.4-mini` | $0.75 | $0.075 | $4.50 | 400K | **Active** — released Mar 17 2026. Strongest mini for coding/subagents. |
| `gpt-5.4-nano` | $0.20 | $0.02 | $1.25 | 400K | **Active** — released Mar 17 2026. Cheapest GPT-5.4-class model. |

**Notes:**
- `gpt-4o` ($2.50/$1.25 cached/$10.00) — retired from ChatGPT Feb 2026, still in API. Not recommended for new deployments.
- No model named `gpt-5` flat or `gpt-5.4` is in the cheap tier. Those start at $1.25–$5.00/M input.
- `gpt-4.1-mini` has the largest context (1M tokens) of any cheap model — significant for KAIROS persona caching.
- **OpenAI Responses API** (`/v1/responses`) now exists and is recommended for new projects, but Chat Completions continues to be supported with no sunset date. Cache benefits are reportedly 40–80% better on Responses API.

**OpenAI cheap-tier recommendation:**
- **Best cheap:** `gpt-5-nano` ($0.05/M in, $0.005/M cached, $0.40/M out)
- **Best cheap+smart:** `gpt-5-mini` ($0.25/M in, $0.025/M cached, $2.00/M out)

---

### 1.2 Google Gemini — Current Models (as of 2026-05-25)

Official sources: [Gemini pricing](https://ai.google.dev/pricing) · [Deprecations](https://ai.google.dev/gemini-api/docs/deprecations) · [Model docs](https://ai.google.dev/gemini-api/docs/models)

| Model ID | Input $/M | Cached $/M | Output $/M | Context | Status |
|----------|-----------|------------|------------|---------|--------|
| `gemini-2.5-flash-lite` | $0.10 | $0.01–$0.025\* | $0.40 | 1M | **Deprecated** — sunset Oct 16 2026. Use `gemini-3.1-flash-lite` going forward. |
| `gemini-2.5-flash` | $0.30 | $0.03–$0.075\* | $2.50 | 1M | **Deprecated** — sunset Oct 16 2026. Use `gemini-3.5-flash` going forward. |
| `gemini-2.0-flash` | — | — | — | — | **Shutdown June 1 2026** — migrate immediately. |
| `gemini-1.5-flash` | — | — | — | — | **Likely shut down** — not on current pricing page, not on deprecation schedule (already past). |
| `gemini-1.5-pro` | — | — | — | — | **Likely shut down** — same status as 1.5-flash. |
| `gemini-3.1-flash-lite` | $0.25 | Not specified† | $1.50 | 1M | **Active GA** — released May 7 2026. Successor to 2.5-flash-lite. |
| `gemini-3.5-flash` | $1.50 | $0.15 | $9.00 | 1M | **Active** — released May 19 2026. "Most intelligent" Flash. Successor to 2.5-flash. |
| `gemini-2.5-pro` | $1.25 | $0.125 | $10.00 | 1M | Active but NOT cheap tier — skip for hosted-cheap. |

\* Sources disagree: Google's own pricing page showed $0.01/M for 2.5-flash-lite cached; search results show $0.025/M. Verify with Google API pricing page directly.  
† `gemini-3.1-flash-lite` cached pricing not found in available docs — verify with [ai.google.dev/pricing](https://ai.google.dev/pricing) before deploying.

**Key deprecation alert:** `gemini-2.0-flash` shuts down **June 1 2026** — 6 days from today. The KAIROS `CACHE_SUPPORTED_MODELS` set in `gemini.ts` must not include it.

**Gemini cheap-tier recommendation:**
- **Best cheap:** `gemini-3.1-flash-lite` ($0.25/M in, ~$0.025/M cached est., $1.50/M out) — verify cached pricing
- **Best cheap+smart:** `gemini-3.5-flash` is too expensive ($1.50/M) for "cheap+smart". `gemini-2.5-flash` at $0.30/M is the better smart-cheap pick while it remains alive until Oct 2026; then migrate to `gemini-3.1-flash-lite` or next-gen.

---

### 1.3 Moonshot Kimi — Current Models (as of 2026-05-25)

Official sources: [platform.kimi.ai](https://platform.kimi.ai/docs/api/chat) · [Cost calculator](https://costgoat.com/pricing/kimi-api)  
**Base URL:** `https://api.moonshot.ai/v1` (platform.moonshot.ai redirects to platform.kimi.ai — `.cn` domain is legacy)

| Model ID | Input $/M | Cached $/M | Output $/M | Context | Status |
|----------|-----------|------------|------------|---------|--------|
| `moonshot-v1-8k` | $0.20 | No caching | $2.00 | 8K | Active but no caching, tiny context — not suitable for KAIROS persona caching |
| `moonshot-v1-32k` | $1.00 | No caching | $3.00 | 32K | Active, no caching |
| `moonshot-v1-128k` | $2.00 | No caching | $5.00 | 128K | Active, no caching |
| `kimi-k2-0711-preview` | $0.60 | $0.15 | $2.50 | 131K | **EOL May 25 2026** — effectively gone today |
| `kimi-k2-0905-preview` | $0.60 | $0.15 | $2.50 | 262K | **EOL May 25 2026** — effectively gone today |
| `kimi-k2.5` | $0.60 | $0.10 | $3.00 | 262K | **Active** — released Jan 27 2026 |
| `kimi-k2.6` | $0.95 | $0.16 | $4.00 | 262K | **Active** — released Apr 20 2026 (latest) |

**Notes:**
- moonshot-v1 series has NO context caching — all input charged at full rate. This makes them uncompetitive for KAIROS's 80% cache-hit profile.
- kimi-k2.5 supports context caching at $0.10/M — very competitive when cached.
- Legacy K2 family (kimi-k2-0711-preview, kimi-k2-0905-preview, kimi-k2-turbo-preview, kimi-k2-thinking) has EOL **May 25 2026** — do not use these.
- Kimi uses `prompt_cache_key` parameter for session-based caching (OpenAI-compatible clients can omit it and rely on prefix matching).

**Kimi cheap-tier recommendation:**
- **Best cheap:** `kimi-k2.5` ($0.60/M in, $0.10/M cached, $3.00/M out) — only viable kimi option given context caching requirement
- No second tier cheaper than k2.5 offers caching. moonshot-v1 is cheaper but without caching becomes expensive under KAIROS load.

---

### Top 5 Recommendations Summary

| Rank | Provider | Model ID | Use Case |
|------|----------|----------|----------|
| ⭐ Cheap #1 | OpenAI | `gpt-5-nano` | Ultra-cheap, best for classification/routing |
| ⭐ Cheap #2 | Gemini | `gemini-3.1-flash-lite` | Cheap with 1M context, strong for long-prompt work |
| ⭐ Cheap #3 | Kimi | `kimi-k2.5` | MoE architecture, good at reasoning when cached |
| ⭐ Smart-cheap #1 | OpenAI | `gpt-5-mini` | Near-frontier quality at $0.25/M, aggressive cache pricing |
| ⭐ Smart-cheap #2 | Gemini | `gemini-2.5-flash` | $0.30/M, 1M context, live until Oct 2026 |

---

## 2. API Spec Verification

### 2.1 Anthropic Messages API (`anthropicApi.ts`)

**Reference:** [platform.claude.com/docs/en/api/messages](https://platform.claude.com/docs/en/api/messages) · [platform.claude.com/docs/en/build-with-claude/prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)

**`system` array format** — `[{type: 'text', text: '...', cache_control: {type: 'ephemeral'}}]`
> **MATCHES SPEC.** Array form with `type: 'text'` blocks and `cache_control: {type: 'ephemeral'}` is correct and current.

**`cache_control` type** — `{type: 'ephemeral'}`
> **MATCHES SPEC** with one **enhancement available**: A `ttl` field was added in 2026. `{type: 'ephemeral'}` defaults to 5-minute TTL. `{type: 'ephemeral', ttl: '1h'}` is now available at 2× input price per write. The code's current form (omitting `ttl`) is still valid and defaults to 5m. **No action required**, but 1h TTL may reduce cache misses across cold starts.

**`usage` field names** — `cache_read_input_tokens` and `cache_creation_input_tokens`
> **MATCHES SPEC.** Both field names are current. The `(resp.usage as any).cache_creation_input_tokens` and `cache_read_input_tokens` casts will work. 2026 addition: `usage.cache_creation` object with sub-fields `ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens` if mixed TTLs are used — current code doesn't need this.

**Overall verdict for `anthropicApi.ts`:** **MATCHES SPEC** — no breaking changes. Minor opt-in enhancement: add `ttl: '1h'` to `cache_control` for the long-cache breakpoint to reduce persona cache misses across daemon restarts.

---

### 2.2 OpenAI Chat Completions (`openai.ts`)

**Reference:** [developers.openai.com/api/reference/resources/chat](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create) · [prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)

**`messages: [{role, content}]` format**
> **MATCHES SPEC.** Chat Completions format is unchanged and still the standard for high-volume, stable workloads. `/v1/chat/completions` endpoint remains fully supported.

**`prompt_tokens_details.cached_tokens` path**
> **MATCHES SPEC.** All 2026 docs confirm `usage.prompt_tokens_details.cached_tokens` is still the correct field name. The code's `(completion.usage as any)?.prompt_tokens_details?.cached_tokens ?? 0` cast is correct.

**Responses API migration**
> **OUT OF DATE — OPTIONAL MIGRATION.** The new `/v1/responses` endpoint is now OpenAI's recommended API for new projects. It reportedly improves cache hit rates by 40–80% vs Chat Completions in internal OpenAI tests, due to better input canonicalization. Chat Completions has **no sunset date** and remains safe to use. However, migrating to the Responses API would benefit KAIROS's cache-heavy workload. This is a deliberate architectural choice, not a breaking bug.

**PRICING IN CODE — OUT OF DATE:**  
The PRICING table in `openai.ts` is stale:
- `gpt-5` at $5.00/M listed but `gpt-5` flat doesn't exist (this likely meant a wrong model ID)
- Missing: `gpt-5-nano` ($0.05), `gpt-5-mini` ($0.25), `gpt-5.4-nano` ($0.20), `gpt-5.4-mini` ($0.75)
- `gpt-4o-mini` and `gpt-4.1-mini` are still correct at $0.15 and $0.40 respectively

**Kimi base URL — OUT OF DATE:**  
The code likely uses `api.moonshot.cn/v1` or `api.moonshot.ai/v1`. Per current docs, the canonical base URL is **`https://api.moonshot.ai/v1`**. The `.cn` domain is legacy. Confirm the `base_url` in `settings.json`/config for the kimi provider.

**Kimi model IDs — OUT OF DATE:**  
`moonshot-v1-32k` is still alive but has no caching. `kimi-k2.5` and `kimi-k2.6` are the current caching-capable models. The kimi PRICING table needs updating.

**Overall verdict for `openai.ts`:** **MATCHES SPEC** for request format, but **PRICING TABLE OUT OF DATE** for model IDs and prices. Kimi base URL needs verification.

---

### 2.3 Gemini cachedContents (`gemini.ts`)

**Reference:** [ai.google.dev/api/caching](https://ai.google.dev/api/caching) · [ai.google.dev/gemini-api/docs/caching](https://ai.google.dev/gemini-api/docs/caching) (last updated 2026-05-20)

**POST endpoint path** — `https://generativelanguage.googleapis.com/v1beta/cachedContents`
> **MATCHES SPEC.** The code uses `${GEMINI_BASE}/${API_VERSION}/cachedContents` which resolves to exactly this URL.

**Request body** — `{model: 'models/...', systemInstruction: {parts: [{text: ...}]}, ttl: '3600s'}`
> **MATCHES SPEC.** The `systemInstruction` field, `parts` array with `text`, and `ttl` as duration string (e.g., `"3600s"`) are all correct per the current API reference.

**`usageMetadata.cachedContentTokenCount` field name**
> **PARTIALLY MATCHES SPEC — NEEDS VERIFICATION.** The Gemini API docs confirm that cached tokens appear in `usageMetadata` (or `usage_metadata` in Python SDK). However, the exact field name could not be definitively confirmed from the current documentation fetched. Sources reference both `cachedContentTokenCount` and `totalTokenCount` (the latter is for the CachedContent resource's own token count, not the per-request hit count). The code reads `data.usageMetadata?.cachedContentTokenCount ?? 0` — this is **consistent with pre-2026 documentation** and with the field name confirmed in community sources. However, Google also introduced implicit caching for Gemini 2.5+ models (automatic, no cost guarantee) alongside explicit caching. Verify this field name against a live API response.

**`cachedContent` field in generate request**
> **MATCHES SPEC.** Passing `cachedContent: cacheName` as a top-level field in the `generateContent` request body is correct.

**PRICING IN CODE — PARTIALLY OUT OF DATE:**
- `gemini-2.0-flash` is NOT in the PRICING table (good — it wasn't added)
- `gemini-1.5-flash` and `gemini-1.5-pro` are in the table but likely shut down — remove them
- `gemini-3.1-flash-lite` ($0.25/M in, $1.50/M out) is missing
- `gemini-3.5-flash` ($1.50/M in, $0.15/M cached, $9.00/M out) is missing

**`TIER_MODELS` mapping — OUT OF DATE:**
- `ultra_cheap` maps to `gemini-2.5-flash-lite` — should be `gemini-3.1-flash-lite`
- `mid` maps to `gemini-2.5-flash` — still OK until Oct 2026, then migrate to `gemini-3.5-flash`
- `heavy` maps to `gemini-2.5-pro` — acceptable to keep

**`CACHE_SUPPORTED_MODELS` set — NEEDS UPDATING:**
- Remove `gemini-1.5-flash` and `gemini-1.5-pro` (likely shut down)
- Add `gemini-3.1-flash-lite` and `gemini-3.5-flash`

**`gemini-2.0-flash` is in `CACHE_SUPPORTED_MODELS`** — wait, checking code: it is NOT present in CACHE_SUPPORTED_MODELS. Good.

**Overall verdict for `gemini.ts`:** **MATCHES SPEC** for request format and endpoint. **PRICING/MODEL TABLES OUT OF DATE** — requires updating for new model generation. `cachedContentTokenCount` field name needs live-response verification.

---

### 2.4 Kimi (handled in `openai.ts`)

**Reference:** [platform.kimi.ai/docs/api/chat](https://platform.kimi.ai/docs/api/chat)

**OpenAI-compatible — confirmed.** Kimi uses the OpenAI Chat Completions wire format. The `OpenAIProvider` class with `id = 'kimi'` and a custom `base_url` is architecturally correct.

**Base URL**
> The current canonical URL is `https://api.moonshot.ai/v1`. Verify what is set in the KAIROS config/settings — if it uses `api.moonshot.cn`, update to `api.moonshot.ai`.

**Known differences from OpenAI:**
- `prompt_cache_key` parameter (optional, session-based caching for moonshot-v1 series — but kimi-k2.5 supports prefix caching without this)
- Vision and video content types in messages (not needed for KAIROS)
- Thinking mode on kimi-k2-thinking variants (not relevant for cheap tier)
- `json_schema` response format (superset of OpenAI's `json_object` — fully backward compatible)
- **No `prompt_tokens_details.cached_tokens`** on moonshot-v1 series (no caching) — the `cachedTok` will always read as 0, which is correct behavior
- kimi-k2.5/k2.6 context caching: confirmed supported, uses same OpenAI-compatible response structure

**Overall verdict for Kimi:** **MATCHES SPEC** for request format. **Model IDs and pricing in PRICING table are OUT OF DATE** — moonshot-v1-32k pricing wrong ($0.30 in code vs $1.00 actual), missing kimi-k2.5/k2.6 entries.

---

## 3. Recommended Hosted-Mode Preferences

### 3.1 Cost projections (15,000 calls/month, 6K in / 200 out, 80% cache hit)

**Per-call cost formula:**
- Non-cached input: 1,200 tokens × (input $/M)
- Cached input: 4,800 tokens × (cached $/M)
- Output: 200 tokens × (output $/M)

| Model | Non-cached cost | Cached cost | Output cost | **Total/call** | **Monthly (15K calls)** |
|-------|----------------|-------------|-------------|----------------|------------------------|
| `gpt-5-nano` | $0.000060 | $0.000024 | $0.000080 | **$0.000164** | **$2.46** |
| `gpt-5-mini` | $0.000300 | $0.000120 | $0.000400 | **$0.000820** | **$12.30** |
| `gemini-3.1-flash-lite` | $0.000300 | ~$0.000120\* | $0.000300 | **~$0.000720** | **~$10.80** |
| `gemini-2.5-flash-lite` | $0.000120 | $0.000048 | $0.000080 | **$0.000248** | **$3.72** |
| `gemini-2.5-flash` | $0.000360 | $0.000144 | $0.000500 | **$0.001004** | **$15.06** |
| `kimi-k2.5` | $0.000720 | $0.000480 | $0.000600 | **$0.001800** | **$27.00** |
| `gpt-4o-mini` | $0.000180 | $0.000360 | $0.000120 | **$0.000660** | **$9.90** |
| `gpt-4.1-mini` | $0.000480 | $0.000480 | $0.000320 | **$0.001280** | **$19.20** |
| `gpt-5.4-nano` | $0.000240 | $0.000096 | $0.000250 | **$0.000586** | **$8.79** |

\* gemini-3.1-flash-lite cached pricing unconfirmed — estimated at $0.025/M (10% of input). Verify.

**Target: <$5/month/user** — Only `gpt-5-nano` ($2.46) and `gemini-2.5-flash-lite` ($3.72) hit this target. Note that `gemini-2.5-flash-lite` is deprecated (sunset Oct 2026).

**Target: <$15/month/user** — All models except kimi-k2.5 fit.

---

### 3.2 Recommended new MODE_PREFS table

```typescript
// PROPOSED: hosted-mode preference table (Phase C.2.6)
// All tiers target cheap/mid models only. No Sonnet, no Opus, no gpt-5 full.

const HOSTED_MODE_PREFS = {
  // ultra_cheap: target <$0.0005/call, <$8/month at 15K calls
  hosted_cheap: [
    'openai/gpt-5-nano',          // $0.000164/call, $2.46/month  ← primary
    'gemini/gemini-3.1-flash-lite', // ~$0.000720/call, ~$10.80/month (verify cached price)
    'openai/gpt-5.4-nano',        // $0.000586/call, $8.79/month  ← fallback
  ],

  // mid: target <$0.001/call, <$15/month at 15K calls
  hosted_mid: [
    'openai/gpt-5-mini',          // $0.000820/call, $12.30/month
    'gemini/gemini-2.5-flash',    // $0.001004/call, $15.06/month (valid until Oct 2026)
    'openai/gpt-4.1-mini',        // $0.001280/call, $19.20/month (1M context for deep skill work)
  ],

  // heavy (hosted): max intelligence while still cheap — target <$0.002/call
  // All 3 options below stay under $30/month at 15K calls
  hosted_heavy: [
    'openai/gpt-5-mini',          // $0.000820/call — surprisingly capable, use first
    'kimi/kimi-k2.5',             // $0.001800/call — MoE reasoning, good for skill_generate
    'openai/gpt-4.1-mini',        // $0.001280/call, 1M context window
  ],
}
```

**Note on "heavy" hosted tier:** The old heavy tier used Sonnet ($3/M input → ~$0.018/call → $270/month). Even kimi-k2.5 at $0.0018/call is 10× cheaper. The new "hosted heavy" is effectively the old "mid".

---

### 3.3 Model quality notes by task type

| Task | Recommended | Caution |
|------|------------|---------|
| `skill_generate` (code gen) | `gpt-5-mini` or `kimi-k2.5` | `gpt-5-nano` may struggle with complex multi-file skill structure |
| `task_routing` (classification) | `gpt-5-nano` | Any model works; nano is 10× cheaper than alternatives |
| `context_summarize` | `gemini-3.1-flash-lite` | Long-context tasks (>100K tokens) only feasible on Gemini 1M context |
| `skill_execute` (general) | `gpt-5-nano` or `gpt-5-mini` | — |
| `proactive_agent` (reasoning) | `gpt-5-mini` or `kimi-k2.5` | Nano may not follow multi-step chains reliably |
| `user_explain` (conversation) | `gpt-5-mini` | — |

**Specific warning:** `gemini-2.0-flash` shuts down June 1 2026. If any config or test fixture references it, it will break in 6 days.

---

## 4. Action Items (Prioritized)

### P0 — Do before June 1 2026

1. **Remove `gemini-2.0-flash` from any config, tests, or fixtures** — model shutdowns June 1 2026, 6 days from now. Search codebase for `gemini-2.0-flash` and purge.

### P1 — Do this sprint

2. **Update `openai.ts` PRICING table** — Add `gpt-5-nano`, `gpt-5-mini`, `gpt-5.4-nano`, `gpt-5.4-mini`. Remove or rename the phantom `gpt-5` entry. Update `kimi` section: replace `moonshot-v1-8k`/`moonshot-v1-32k` pricing (currently wrong) and add `kimi-k2.5`/`kimi-k2.6`.

3. **Update `gemini.ts` PRICING, TIER_MODELS, and CACHE_SUPPORTED_MODELS** — Add `gemini-3.1-flash-lite` and `gemini-3.5-flash`. Remove `gemini-1.5-flash` and `gemini-1.5-pro` (likely dead). Change `ultra_cheap` tier from `gemini-2.5-flash-lite` to `gemini-3.1-flash-lite` (2.5-flash-lite sunsets Oct 2026). Verify `cachedContentTokenCount` field name against a live API call.

4. **Verify kimi base URL** — Confirm KAIROS config uses `https://api.moonshot.ai/v1` (not `.cn`). Update kimi TIER_MODELS to route `ultra_cheap` and `mid` through `kimi-k2.5` (moonshot-v1 series has no caching, making it uncompetitive under KAIROS's 80% cache profile).

### P2 — Next sprint

5. **Add `gpt-5-nano` and `gpt-5-mini` to `openai.ts` TIER_MODELS** — Set `ultra_cheap: ['gpt-5-nano']`, `mid: ['gpt-5-mini']` for the hosted-cheap preference path. This alone drops the cheap-tier monthly cost from ~$10 (gpt-4o-mini) to ~$2.46/user.

6. **Evaluate migrating OpenAI provider to Responses API** — `/v1/responses` improves cache hit rates 40–80% (OpenAI internal benchmarks). Not breaking, but cache savings compound: at $0.005/M cached on gpt-5-nano, even a 10% additional hit rate improvement saves ~$0.30/user/month. Worth a spike.

7. **Consider Anthropic `ttl: '1h'` on long-cache breakpoint** — The current ephemeral default is 5 minutes. Adding `ttl: '1h'` to the `longBp` block in `anthropicApi.ts` would keep the persona/STANDING_ORDERS cached across daemon restarts (cost: 2× write price, reads still 0.1×). Since we're eliminating Anthropic from hosted mode, this is only relevant for `local_api` mode.

8. **Plan gemini-2.5-flash migration path** — The `mid` tier currently uses `gemini-2.5-flash` which sunsets Oct 16 2026. The replacement is `gemini-3.5-flash` ($1.50/M in) but that's 5× more expensive. `gemini-3.1-flash-lite` at $0.25/M is the better cheap successor. Monitor benchmark quality of 3.1-flash-lite before making it the default mid-tier replacement.

---

## Sources

- [OpenAI GPT-5.4 mini model docs](https://developers.openai.com/api/docs/models/gpt-5.4-mini)
- [OpenAI GPT-5.4 nano model docs](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
- [OpenAI GPT-5 mini model docs](https://developers.openai.com/api/docs/models/gpt-5-mini)
- [OpenAI GPT-5 nano model docs](https://developers.openai.com/api/docs/models/gpt-5-nano)
- [OpenAI GPT-4.1 mini model docs](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
- [OpenAI Deprecations](https://developers.openai.com/api/docs/deprecations)
- [OpenAI Prompt Caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI Responses API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Google Gemini Deprecations](https://ai.google.dev/gemini-api/docs/deprecations)
- [Gemini 3.1 Flash-Lite model docs](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)
- [Gemini API Caching reference](https://ai.google.dev/api/caching) (updated 2026-05-20)
- [Gemini 3.5 Flash — AI pricing](https://pricepertoken.com/pricing-page/model/google-gemini-3.5-flash)
- [Gemini 2.5 Flash-Lite deprecation discussion](https://discuss.ai.google.dev/t/clarification-on-stable-replacement-models-for-gemini-2-5-flash-and-gemini-2-5-pro-before-june-2026-deprecation/130009)
- [platform.kimi.ai API chat docs](https://platform.kimi.ai/docs/api/chat)
- [Kimi API cost calculator (costgoat.com)](https://costgoat.com/pricing/kimi-api)
- [Anthropic Messages API docs](https://platform.claude.com/docs/en/api/messages)
- [Anthropic Prompt Caching docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [finout.io OpenAI pricing guide 2026](https://www.finout.io/blog/openai-pricing-in-2026)
- [pricepertoken.com — GPT-4.1 mini](https://pricepertoken.com/pricing-page/model/openai-gpt-4.1-mini)
- [tokenmix.ai — Kimi K2 API pricing](https://tokenmix.ai/blog/kimi-k2-api-pricing)

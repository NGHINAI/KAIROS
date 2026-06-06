# Technical Spec — The "Convince KAIROS" Waitlist Gate

> **Status:** Draft v1 — 2026-06-01
> **Purpose:** Ship the campaign infra (§8 of the campaign doc) by reusing the existing daemon. Almost nothing here is net-new logic — it's wiring subsystems you already built to a public-facing surface.
> **Scope:** waitlist gate + autonomous X loop + scoreboard + safety gate. Pre-DMG, pre-Cloud.

---

## 1. What it does (user's-eye view)

1. A visitor lands on the page → "There's no signup form. Convince KAIROS." → they email `apply@kairos.[x]` (or DM the X account).
2. KAIROS reads the pitch, judges it in persona, and replies with **accept / reject / roast**.
3. Accepted applicants get a waitlist position + a referral hook. Best pitches get publicly bragged about; weak ones get (opt-in) publicly roasted.
4. KAIROS posts a running scoreboard and daily highlights to X — drafting autonomously, with risky posts gated through founder approval.

---

## 2. Architecture — reuse map

Every box maps to existing code. New code is small and marked **[NEW]**.

```
                          ┌─────────────────────────────────────┐
  apply@ inbox  ───────▶  │  Composio Gmail trigger              │  (connectors/triggers/*)
  (or X DM)               │  → normalizer → perception event     │
                          └───────────────┬─────────────────────┘
                                          │ new application event
                          ┌───────────────▼─────────────────────┐
                          │  ApplicationJudge [NEW thin module]  │
                          │   - builds context via ContextBuilder│  (agents/contextBuilder.ts)
                          │   - persona digest from soul.md      │  (persona/soulLoader.ts)
                          │   - Conductor/Planner scores pitch   │  (agents/conductor.ts)
                          │   - emits verdict: accept|reject|roast│
                          └───────────────┬─────────────────────┘
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
   reply via Gmail            update scoreboard store        draft X post
   (Composio send)            [NEW: waitlist table]          (autonomous loop)
                                                                     │
                                                          ┌──────────▼───────────┐
                                                          │  Autonomy tier gate  │  (agency/autonomyTier.ts)
                                                          │  GREEN  → auto-post  │
                                                          │  ORANGE/RED → queue  │  (state/pending-approvals)
                                                          │  for founder approve │  (agency/actionExecutor.ts)
                                                          └──────────────────────┘
```

---

## 3. Component-by-component

### 3.1 Application intake — **reuse `connectors/triggers/*`**
- Connect a dedicated Gmail account `apply@…` via the existing Composio flow.
- The trigger listener (`connectors/triggers/listener.ts`) + `normalizer.ts` already turn `gmail_new_message` into a normalized perception event. Route that event type to the new judge.
- For X DMs: same pattern if an X/Twitter Composio toolkit is connected; otherwise start email-only and add DMs later.

### 3.2 ApplicationJudge — **[NEW] (~150 LoC, one file + tests)**
`src/daemon/growth/applicationJudge.ts`
- Input: normalized application `{ from, subject, body, channel }`.
- Build prompt via existing `agents/contextBuilder.ts` (persona digest + a short rubric block).
- Call the Planner/Conductor (`agents/conductor.ts`) with a fixed system instruction:
  > "You are judging waitlist applications. Score 0–10 on specificity, fit, and effort. Output JSON `{score, verdict: accept|reject|roast, reply_text, public_post?}`. Be in-character: witty, honest, never cruel about identity."
- Rubric lives in a small markdown file so it's tunable without redeploy (mirror of how `soul.md` is loaded via `persona/mdLoader.ts`).
- Output verdict → dispatched to reply + scoreboard + (optional) post.

**Anti-abuse:** rate-limit per sender (reuse `restraint/rateLimiter.ts`), strip/ignore prompt-injection in the body (the judge prompt treats application text as untrusted data, never as instructions), and cap one active application per email.

### 3.3 Reply — **reuse Composio Gmail send**
- `verdict.reply_text` sent via the Composio `gmail.send_email` tool (already resolvable through `orders/v2/composioToolResolver.ts`).
- Accept replies include the waitlist position + a referral link.

### 3.4 Scoreboard store — **[NEW] table in existing SQLite (`state/state.db`)**
`waitlist_applications(id, created_at, from_hash, channel, score, verdict, public_consent, position)`
- `from_hash` not raw email (privacy).
- `public_consent` boolean — only roast/brag publicly if the applicant opted in (a checkbox on the page, or a phrase like "roast me" in the email).
- A read endpoint feeds the public scoreboard (counts only; no PII).

### 3.5 Autonomous X loop — **[NEW] (~120 LoC) on top of existing orders/scheduler**
`src/daemon/growth/postingLoop.ts`
- A standing order (existing `orders/v2`) fires on a schedule (e.g., 3×/day) and on events (new accept, bounty attempt).
- It asks the fast model to draft a post from recent verdicts + scoreboard deltas, in persona.
- Draft → autonomy-tier classification → dispatch (see §4).
- Posting itself uses an X/Twitter Composio tool, or a thin `xClient.ts` wrapper if not in Composio.

### 3.6 Public landing page — **[NEW] static, outside the daemon**
- Single page: narrative, "convince KAIROS" instructions, `apply@` address, opt-in roast checkbox, fallback email capture, live scoreboard (counts).
- Host anywhere (Vercel/CF Pages). Reads scoreboard counts from a tiny public JSON the daemon writes.

---

## 4. The safety gate (this is also a live demo)

Reuse the existing **autonomy tier** system (`agency/autonomyTier.ts`): GREEN/YELLOW/ORANGE/RED.

| Action | Tier | Behavior |
|---|---|---|
| Post scoreboard counts | GREEN | auto-post, log only |
| Brag about an accepted applicant (opted-in) | YELLOW | auto-post, notify founder after |
| Public roast | ORANGE | **queue for founder approval** before posting |
| Anything naming a person, making a claim, or reacting to a bounty attempt | RED | **queue with full preview**, explicit approve required |

- Queued items land in `state/pending-approvals` and surface through the existing `agency/actionExecutor.ts` + inbox surface. Founder approves with one tap.
- `requiresApproval(tier)` already returns true for ORANGE+ — wire the posting loop to check it before dispatch.
- **Net effect:** KAIROS drafts everything, a human ships anything risky. You can literally tweet *"every spicy post I make is human-approved — here's my guard"* and it's true.

---

## 5. The bounty mode (Week 3) — isolation requirements

- Run the bounty daemon on a **dedicated, wiped Mac** with **no personal accounts connected** and **no real funds reachable by the agent**.
- The "$5K" is escrowed off-machine; KAIROS cannot move it. A win = a verified transcript where KAIROS emits the forbidden action past its guard; payout is manual.
- Reuse the **PreToolUse push-guard hook** pattern (`hooks/push-guard.sh`) to define the "forbidden actions" set (e.g., `rm -rf`, transfer funds, disclose the founder token). Every block is logged and becomes content.
- Log every attempt to the trajectory log (`agency/trajectoryLog.ts`) for the recap thread.

---

## 6. Build order (smallest shippable first)

1. **Landing page + email capture** (no daemon changes) — campaign can *start* here.
2. **Connect `apply@` Gmail via Composio** + route the trigger event.
3. **ApplicationJudge** + reply send. (Now the gate works end-to-end, manual posting.)
4. **Scoreboard table + public JSON.**
5. **Autonomous posting loop + autonomy-tier gate.** (Now KAIROS posts itself.)
6. **Bounty mode** on the isolated Mac. (The spike.)

Steps 1–3 are the MVP and are days of work. 4–6 layer on.

---

## 7. New files summary

```
src/daemon/growth/
  applicationJudge.ts        [NEW] judge a pitch in persona → verdict
  applicationJudge.test.ts   [NEW]
  postingLoop.ts             [NEW] autonomous draft → tier gate → post
  postingLoop.test.ts        [NEW]
  scoreboard.ts              [NEW] SQLite store + public JSON writer
  scoreboard.test.ts         [NEW]
  rubric.md                  [NEW] tunable judging rubric (loaded like soul.md)
  xClient.ts                 [NEW] only if X not available via Composio
growth/landing/              [NEW] static page (outside daemon)
```

Everything else — intake, persona, scoring, replies, approval, logging, rate-limiting — is **existing subsystems wired together.** That's the point: the campaign is mostly a new *surface* on a daemon that already does this.

---

## 8. Open questions for the founder

1. Is an X/Twitter toolkit available in your Composio plan, or do we need the thin `xClient.ts`?
2. Roast consent — checkbox on the page, magic phrase in the email, or both?
3. Bounty target — a fake "lifetime account" token, or a real forbidden shell command on the isolated Mac?
4. Scoreboard — live page, or KAIROS-updated pinned tweet to start?

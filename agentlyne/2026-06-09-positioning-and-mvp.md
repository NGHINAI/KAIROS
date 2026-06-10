# Agentlyne — Positioning & MVP Recommendation

**Date:** 2026-06-09 · **Status:** Draft for decision
**Input:** kairos-sandbox research docs (proactive-agent landscape, Clicky teardown, virality playbook) + fresh web research (June 2026)

---

## 1. The landscape, honestly (June 2026)

| Category | Who | What they own | Why it's not the gap |
|---|---|---|---|
| Reactive copilots | ChatGPT, Claude | "Ask AI anything" | Commodity. You prompt, it answers. |
| Cursor buddies | **Clicky** (Farza) | "AI that sees your screen and teaches you" | Reactive (push-to-talk). Helps you do work; doesn't do it. Huge attention, open-sourced. |
| Email/calendar EAs | **Lindy**, Fyxer, Serif | "Saves 2 hrs/day on inbox + meetings" | Email-first wedge is taken and crowded. Mostly user-configured, deterministic workflows. |
| AI employees | **Vellum** | Persistent memory + proactive identity in your channels | Closest neighbor. Chat-channel-centric, B2B-employee framing. |
| Computer-use agents | ChatGPT Agent (ex-Operator) | "Give it a task, it clicks through" | 38% OSWorld success, stops to ask permission constantly. Reactive: you still initiate. |
| Ambient agents (concept) | LangChain / Harrison Chase | Event-driven agents + "agent inbox" | A developer framework/idea. **No consumer product owns this category yet.** |
| Open-source daemons | OpenClaw/Hermes, Screenpipe | Heartbeat suppression; 24/7 sensors | Headless dev tools, not products. |

**The open gap:** every product above is either *reactive* (you initiate) or *deterministic* (you pre-build the workflow). Nobody owns: **an agent that notices on its own, plans its own multi-step route, executes across your apps, and hands you a finished result.** "Chief of staff" is also now a crowded Product Hunt category — and it connotes *advice and triage*, not *execution*. Your instinct is right: drop it.

---

## 2. Recommended positioning

**Category to claim: the autonomous operator.** Not an assistant (waits), not a copilot (sits beside you), not a chief of staff (advises). An operator: **work finishes itself.**

- **One-liner:** *"Agentlyne notices what needs doing and finishes it — before you ask."*
- **Category line:** *The first truly proactive AI — it doesn't wait for instructions.*
- **Against Lindy/automation tools:** "They run the workflows you build. Agentlyne figures out the steps itself." (agentic planner vs. deterministic pipelines — this is your "not a deterministic flow" point, and it's the defensible technical claim because of the Conductor/Planner architecture)
- **Against Clicky:** "Cursor buddies help you work. Agentlyne works." (counter-programming already drafted in `growth/KAIROS-vs-Clicky-playbook.md`)
- **Against computer-use agents:** "You don't give Agentlyne tasks. It finds them."

**Proof stack (what makes the claim true, from the existing tech):**

1. **Perception, not polling** — event-driven triggers from calendar/CRM/files/screen (trigger engine, Composio triggers).
2. **Earned interrupts** — suppression pattern: it evaluates constantly, surfaces only signal (earned-interrupt phase, HEARTBEAT_OK lineage).
3. **Self-planned multi-step execution** — Conductor + Planner decide the route per situation; narration explains while acting.
4. **Receipts** — every autonomous run produces a reviewable artifact (what it saw → what it did → what you got). This is the trust mechanism AND the viral asset.
5. **It compounds** — crystallized skills: flows it has done before get faster, cheaper, more reliable (AWM skills phase).

**Trust ladder (the adoption objection killer):** autonomy is earned per flow-type: Suggest → Draft → Do-with-approval → Do-and-report. User promotes/demotes. Agent inbox holds approvals + receipts. (LangChain validated the pattern; nobody productized it for consumers.)

---

## 3. MVP recommendation

**Principle:** one autonomous loop, three hero flows, fifty users. Not a platform. Every flow must be: proactive (it initiates), multi-step (5+ steps, plan varies), cross-app, and demo-able in 30 seconds. **Not email-first** — email is the result of some flows, never the wedge.

**Hero flows (pick 2 of 3 for v1):**

1. **Meeting operator** — calendar event appears → researches attendees/company → preps a brief → after the meeting, drafts follow-ups + files action items into your tracker. Trigger: calendar. Visible twice a day.
2. **Inbound operator** — new lead/DM/form-fill appears → enriches → qualifies against your ICP → drafts the reply + books the slot + updates CRM → asks one approval. Trigger: CRM/webhook/X DM. Directly tied to money — easiest "it paid for itself" story.
3. **Morning operator** — overnight: triages everything that accumulated, prepares the day, queues decisions in the agent inbox. You wake up to finished work. Trigger: time + accumulated events. The cinematic demo (this is the "do-nothing morning" clip format from the IDLE work — reuse it).

**Recommend 2 + 3** (inbound + morning): one earns money, one earns the demo. Meeting operator is v1.1.

**MVP architecture is already ~70% built in kairos-sandbox:** tick loop, trigger engine, Conductor/Planner/Narrator, Composio connectors, memory, approval hooks, voice. The MVP work is: hardening 2 hero flows end-to-end, the agent inbox surface (Electron app is at framework stage), and onboarding. The 2026-06-08 chief-of-staff roadmap's three learning loops (you-policy, skills, self-grading) are the *moat*, not the MVP — ship flows first, learning loops behind them.

**MVP success metrics:** autonomous completions/user/week (target ≥5), approval rate on proposed actions (≥70%), interrupt precision (dismissal rate <20%), time-to-first-autonomous-win (<24h from install).

---

## 4. Virality, designed in (not bolted on)

Cluely proved rage-bait gets attention ($15M raise) and then proved attention without substance implodes — investors now favor sustainable narratives. The IDLE Experiment format you already locked (`growth/00-MASTER-PLAN.md`) threads this: **spectacle that is literally the product demo** — the agent launches itself in public. Carry it over to Agentlyne:

1. **The agent runs its own launch** — own X account, posts its own receipts, runs its own waitlist with a public signup goal. The meta is the proof.
2. **Convince-gate waitlist** — no form; you convince the agent to let you in (spec already written).
3. **Receipts as content** — every autonomous completion can render a shareable before/after card. Users post your demos for you. This is the compounding loop the IDLE docs didn't have.
4. **Counter-programming** — "the cursor-buddy era is the last era of you doing the work" (playbook exists).
5. **50-seat concierge beta** — scarcity + hand-onboarding (START-HERE plan applies as-is).

---

## 5. ⚠ Naming risk (decide early)

"Agentlyne" collides hard: **Agently** (.com real-estate, .ai travel, .dev "AI team for founders", .net CRM), **AgentLine** (agentline.cloud voice AI, agentline.shop, agentline.org), **AgentLink**. Spoken aloud, "Agentlyne" is indistinguishable from "AgentLine" — bad for a voice-first product and for SEO. Options: (a) keep Agentlyne as company, ship product under a clean name (IDLE is still strong and locked); (b) rename before any public posting; (c) accept and outrank — expensive. **Recommend (a).**

---

## 6. Decisions needed from you

1. Product name vs. company name (see §5).
2. Hero flows: confirm inbound + morning, or swap in meeting operator.
3. Which connectors for the inbound flow (which CRM do beta users actually use — Close? HubSpot? X DMs only?).
4. Beta platform: macOS-only first (matches current build) — confirm.

## Sources

- [Lindy](https://www.lindy.ai/) · [Vellum AI-employees comparison](https://www.vellum.ai/blog/best-ai-employees) · [Mastra: Best AI personal assistants 2026](https://mastra.ai/blog/best-personal-ai-assistants-in-2026)
- [Clicky — heyclicky.com](https://www.heyclicky.com/) · [XDA review](https://www.xda-developers.com/someone-built-tiny-ai-that-lives-next-to-your-cursor-the-most-useful-thing-ive-tried-this-year/) · [github.com/farzaa/clicky](https://github.com/farzaa/clicky)
- [OpenAI CUA](https://openai.com/index/computer-using-agent/) · [Operator→ChatGPT Agent tracker](https://presenc.ai/research/openai-operator-update-tracker-2026) · [Coasty Operator review (38% OSWorld)](https://coasty.ai/blog/openai-operator-review-2026-20260504)
- [Sequoia × Harrison Chase: Ambient agents & the agent inbox](https://sequoiacap.com/podcast/training-data-harrison-chase-2/)
- [TechCrunch: Cluely's rage-bait strategy](https://techcrunch.com/2025/10/29/cluelys-roy-lee-on-the-ragebait-strategy-for-startup-marketing/) · [Quasa: Cluely implosion](https://quasa.io/media/rage-bait-not-a-strategy-as-proven-by-cluely-s-implosion)
- [Agently.com](https://www.agently.com/) · [Agently.dev](https://www.agently.dev/) · [AgentLine.cloud](https://agentline.cloud/) — name-collision evidence
- Internal: `docs/research/2026-05-24-proactive-agent-landscape.md`, `docs/clicky-teardown-research.md`, `growth/00-MASTER-PLAN.md`, `docs/superpowers/specs/2026-06-08-proactive-chief-of-staff-roadmap.md`

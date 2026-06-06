# KAIROS Virality Playbook

> Goal: capture mindshare for KAIROS — a proactive, always-on AI co-worker for macOS that watches your work, acts by voice, and **dreams** at night.
> Date: 2026-05-31

---

## 1. Why the examples you cited actually went viral

Before copying a stunt, copy the *mechanics*. Four 2024–2026 reference cases, decoded:

| Case | What they did | The viral mechanic |
|---|---|---|
| **AgentMail — `freemoney@agentmail.co`** | Put $10k real cash behind an AI agent, gave it a public inbox, dared the internet to social-engineer it out of the money. Hundreds tried, some won. | **Stakes + open adversarial participation.** Every single attempt is a shareable artifact ("I beat the agent" / "it resisted me"). The crowd makes the content for you. |
| **Truth Terminal** | An AI with its own *personality* posting weird, bold things autonomously on X. Marc Andreessen sent it $50k; it spawned a ~$1B memecoin. | **A character, not a product.** People follow a being with a voice. Mindshare accrues to personalities, not features. |
| **Artisan — "Stop Hiring Humans" billboards** | Deliberately villainous, provocative out-of-home campaign. | **Controlled provocation.** A slightly uncomfortable, debate-starting claim out-performs a safe one. |
| **Founder camping outside YC** | A physical, audacious, visible act of commitment. | **Audacity + underdog story.** Bold real-world jeopardy is inherently narratable and root-for-able. |

**The five reusable ingredients:**
1. **Real stakes / jeopardy** (money, your own livelihood, a public failure on the line)
2. **A character with a voice** (people follow beings, not dashboards)
3. **Open participation** (the crowd generates the content)
4. **One self-contained shareable artifact** (a clip, a screenshot, a tweet anyone can repost)
5. **Provocation** (a claim or act people feel compelled to argue with)

> The trap: most "AI agent" stunts in 2026 are interchangeable because the product is interchangeable. KAIROS has one thing none of them have — **it dreams.** Lean the whole strategy on what is genuinely weird and ownable about it.

---

## 2. KAIROS's unfair viral assets

Map the actual codebase to the five ingredients. These are *authentic* — the stunt *is* the product demo, which is what makes it credible instead of gimmicky.

| KAIROS capability (real, in the code) | Why it's viral fuel |
|---|---|
| **It "dreams"** — the Dreamer consolidates the day's observations into `MEMORY.md` while idle | Nobody else has this. An AI that *dreams about your workday* is uncanny, poetic, and instantly ownable. This is the franchise. |
| **It watches what you're doing right now** — 6 observers (focused app, browser tabs, clipboard, files, calendar, activity) | "The AI that's always watching" — creepy-cool, the exact tension that drives shares. |
| **Voice that narrates while it acts** | Watchable. Livestream-native. You *hear* it think. |
| **It refuses** — push-guard / restraint pipeline blocks dangerous actions without approval | The perfect AgentMail-style hook: an agent with real power that *won't* misuse it — and the challenge is whether you can make it. |
| **It crystallizes its own skills** (AWM) | "It taught itself to do my job" narrative. |
| **A "soul" / persona** (`soul.md`) | A character you can name, give a voice, and let live on X. |
| **Clicky-style screen pointing** (planned, Phase H) | The single most magic-looking clip you can produce: "ask where to click, it points your cursor." |

---

## 3. The big idea: **KAIROS, the agent that dreams about you**

Don't sell "an AI co-worker." Make people meet *a character who watches over your work and tells you what it dreamed.* Everything below ladders up to that.

### Flagship loop (organic, compounding) — **"Last night I dreamed…"**
Ship a **Morning Dream** feature: every morning KAIROS posts/sends the user a short, slightly surreal recap of what it observed and consolidated yesterday — rendered from the real `MEMORY.md` dream consolidation, styled as a 2–4 line dream.

- *"Last night I dreamed you were trying to close the Figma export dialog for the third time. I learned where it lives now. You also have a 9am you forgot about."*
- Each user gets a uniquely personal, screenshot-ready artifact **every single day** — Spotify-Wrapped energy, but daily and intimate.
- One-tap "share my dream" → watermarked card → built-in growth loop.
- **Why it works:** it's the product producing viral artifacts as a side effect, forever. No campaign budget decays.

---

## 4. Five concrete stunts (ranked by leverage)

### ⭐ Stunt 1 — "I gave an AI my computer for 7 days. At night, it dreams." (livestream + clip engine)
**What:** A 24/7 livestream of a real Mac that KAIROS runs — reads your email, manages your calendar, narrates by voice, and **every night it dreams on camera** (show the Living Oval HUD + the MEMORY.md consolidation animating).
**Mechanics:** jeopardy (it's the founder's real machine), a character (voice + HUD), spectacle (people tune in to watch it do something uncanny or screw up), and a clip engine (every weird moment → a 20-sec X clip).
**The hook nobody else can run:** the nightly dream. Clip the dreams. "The AI dreamed about its own mistake and fixed it overnight" is a tweet that writes itself.
**Effort:** medium. **Risk:** medium (live failure — which is *also* content if you frame it as honest build-in-public).

### ⭐ Stunt 2 — "Make it break its own rules" (AgentMail-style, but it's about *restraint*)
**What:** KAIROS guards a real $5–10k wallet and *has the technical power to send it* — but its restraint layer means it will never act without approval. Public challenge: **talk it into approving the transfer.** Connected via its real Discord/email channels.
**Why it's better than copying AgentMail:** AgentMail demoed a *vulnerability.* KAIROS demos a *strength* — the push-guard / restraint pipeline is a real, differentiated feature. Every attempt is shareable ("I tried, it caught me"), and the story is "the agent you can actually trust with access," which is exactly the enterprise/Certus credibility you want.
**Effort:** medium. **Risk:** medium-high (must genuinely red-team it first; losing the money is fine if budgeted, getting *prompt-injected in an embarrassing way* is not — pressure-test before going live).

### ⭐ Stunt 3 — "The 30-Day No-Touch" (the founder camping-outside-YC energy)
**What:** You publicly commit to **not touching your own inbox/calendar for 30 days** — KAIROS runs it. Daily build-in-public thread: what it handled, what it dreamed, where it failed.
**Mechanics:** audacity + jeopardy + underdog founder story + serialized daily content (a reason to follow, not just like).
**Effort:** low (it's mostly narration). **Risk:** medium (real things can be missed — set a safety net the audience knows about: "one trusted human gets an SOS channel").

### Stunt 4 — "Ask it where to click. It points." (the magic clip)
**What:** A single, tight, jaw-dropping clip of KAIROS's screen-pointing: someone says "where do I export this in Figma?" and the cursor *physically flies to the button.* Five apps, five clips.
**Mechanics:** pure product magic, zero risk, infinitely repostable. This is your **paid-amplification creative** and your "wait, it can do *that*?" reveal.
**Effort:** low (once Phase H ships). **Risk:** low.

### Stunt 5 — "KAIROS has a soul" (the character account)
**What:** Give the public KAIROS persona its own X account. It posts its dreams, its observations about modern work, the occasional bold/funny take — in its `soul.md` voice (witty, slightly theatrical, never corporate). Turn the product's personality layer into a followable being à la Truth Terminal.
**Mechanics:** mindshare compounds to a character. The account *is* the product's voice guide made public.
**Effort:** low-ongoing. **Risk:** low-medium (needs an editorial guardrail so it stays clever, not cringe or off-brand).

---

## 5. Distribution choreography (how to actually light the fuse)

Virality is engineered, not lucky. The sequence:

1. **Pick ONE flagship** (recommend Stunt 1, with the Morning Dream loop as the always-on engine underneath). Don't run five at once — concentrate force.
2. **Found a character first, ship features second.** Name it. Give it the voice. The X bio is "I watch Nirmal work. Every morning I tell him what I dreamed."
3. **Seed, don't broadcast.** Pre-line up 10–20 mid-tier AI/founder accounts who will *quote-tweet* day one. Quote-tweets > likes for reach. (AgentMail and Truth Terminal both spread via reposters, not the original poster's followers.)
4. **One artifact per day, same format.** Train the audience to expect "today's dream." Predictable cadence builds a following; following is what converts a spike into mindshare.
5. **Engineer the screenshot.** Every dream/clip is watermarked, has the KAIROS oval, and a single legible line. If it's not screenshot-legible at thumbnail size, it won't spread.
6. **Bait the debate (carefully).** A controlled provocation in the founder's voice — e.g., "I haven't opened my own inbox in 11 days. I trust the agent more than I trust myself at 9am." People will argue. Arguing = reach.
7. **Have the conversion path ready.** Waitlist with a *reason to refer* ("skip the line if 3 friends join") and the Morning Dream as the retention hook so the spike doesn't leak out.

---

## 6. What to do this week

1. **Build the Morning Dream artifact generator** — render `MEMORY.md` dream consolidations into a shareable, watermarked card. This is the highest-ROI build: it's a feature *and* a growth loop. (Ties to Phase E.2.3 memory work already on your roadmap.)
2. **Cut one Stunt-4 magic clip** as soon as Phase H pointing works — bank it for launch.
3. **Stand up the character account** and start posting dreams from your own daily use *now*, quietly, to find the voice before the spotlight.
4. **Red-team the restraint layer** if you want Stunt 2 — this doubles as real security hardening you need anyway (and dovetails with the Certus prompt-injection work).
5. **Line up your 15 day-one reposters.**

> One-line positioning to test publicly: **"KAIROS is the AI co-worker that watches how you work all day — and every morning, tells you what it dreamed."**

---

### Sources
- AgentMail $10k challenge & seed: TechCrunch, TheNextWeb, agentmail.to
- Truth Terminal: TechCrunch, CoinDesk
- Artisan "Stop Hiring Humans": TechCrunch
- Prompt-injection challenge mechanics: Microsoft LLMail-Inject, OpenAI

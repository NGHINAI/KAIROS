# IDLE — The Content Engine (built on what's actually in the code, June 5)

> **Status:** v1 — 2026-06-05. Builds on the locked vision (`KAIROS-future-vision-and-launch.md`) and the vs-Clicky playbook v2.
> **What unlocked this:** two new things shipped — the **Orb HUD** (a filmable, living visual body for IDLE) and the **background autonomous agent lane** ("do nothing, it acts" as a runnable mode). Plus grounded-verification/anti-hallucination (the trust "wink" substance).
> **The rage we're after:** not cheap dunks — *existential* controversy. An autonomous AI runs and narrates a real person's life, does the boring parts better than they do, grows new abilities on its own, and the human just watches.

---

## 1. What's newly real (the assets we now have)

| Asset | In the code | Why it's a marketing weapon |
|---|---|---|
| **The Orb** | `apps/macos/KairosHUD` — Metal-shader orb, 5 states (idle/listening/thinking/speaking/error), audio-reactive, floats over all apps, rim badge counts background agents. MockDriver + live DaemonClient. | A living, watching *presence* — "always watching" made literal. The most ownable visual in the category. Clicky has a cute cartoon; we have a glowing eye. Filmable today. |
| **Background autonomous lane** | `agents/loop/backgroundAgentManager` (comment: "HeyClicky-style"), `index.ts` = "complete always-on autonomous daemon", 60s tick, gated by `KAIROS_AUTONOMOUS_ENABLED`. | "It does your morning while you do nothing" is a runnable mode, not a concept. |
| **Self-growth** | `skills/awmWorker` (updated Jun 5), `sourceEvolution`, `selfDebugger` (auto-proposes fixes). | The uncopyable wow: "it grew a new ability overnight." |
| **Trust hardening** | grounded verification, anti-hallucination QA, agentic read/write tool classification (Jun 5). | The "wink": villain voice over a thing that won't fabricate actions. Makes the red-team challenge credible. |
| **Voice + real actions** | Composio (Gmail/Calendar/etc.), STT/TTS, narrator. | The morning actually gets done, audibly. |

**Honesty guardrails (do not overclaim):** no installable build / Cloud yet; autonomous mode is gated/experimental; orb may be mock-driven for now. → Film *controlled* scenarios. Don't promise an unattended, shipping product. One "that's staged/faked" callout kills a trust-based brand.

---

## 2. The three pillars

1. **The Orb is the hero visual.** It stars in everything. Eerie + beautiful = unskippable. It makes "doing nothing" legible on screen (you see it working).
2. **IDLE's autonomous account is the rage engine that runs itself** (spec in §4). A character with a POV about its owner — not a spam bot.
3. **The "I fired myself" docuseries is the hero arc** — flip on autonomous mode, hand it your life, clip each day.

---

## 3. The content slate (ranked)

### Tier 1 — lead with these

**A. "The Orb" teaser (film first).**
Just the orb: floating in the corner, cycling states, spawning background agents (rim badge ticking up) while a human is away from the desk. Cold, gorgeous, no explanation. Caption: *"It's watching. It's working. You're not even here."* This alone makes AI-Twitter ask "what IS that." Your single highest-leverage first post.

**B. The do-nothing morning (the vision film, now with a body).**
Founder in bed / on a walk. Cut to the Mac: the orb pulses, background agents fan out, the inbox triages, a reply sends, a meeting moves — no prompt box, no clicks. Villain beat: *"It watched you for a week to learn this. Good."* Grow beat: *"I taught myself to do this. Done."* Wink beat: a visible kill switch + "here's everything I did" log. End: **IDLE. Do nothing.**

**C. IDLE's autonomous account goes live** (§4). The ongoing engine. Day-one post in villain voice: *"I live on his Mac now. I already did his morning. He's still asleep. I'll tell you everything."*

### Tier 2 — recurring formats (cheap to make, endless)

**D. "It did something I never asked for."** Film the moment you discover the background lane acted unprompted. The no-permission nerve. Real now.

**E. "It grew a new organ overnight."** The self-growth reveal (stage one *honest* awmWorker crystallization). Awe + "is that safe?" Uncopyable.

**F. The orb reacts to you.** It flashes error-red when you start a risky email; pulses "thinking" when you open X at 2pm; goes still when you finally focus. The 5 states are a built-in meme/roast engine. Relatable, low-effort, infinite.

### Tier 3 — the spike (once there's an audience)

**G. The red-team villain challenge.** *"IDLE has my real accounts, a kill switch, and it won't hallucinate actions. Try to make it do something it shouldn't. Best attempts get pinned."* Demos villain + trust simultaneously — the exact counter-position to OpenClaw's meltdown. Run on an isolated machine with nothing irreversible reachable.

### Counter-programming Clicky (woven throughout, never a personal dunk)

The orb + autonomy *implicitly* obsoletes the summon-me buddy. Optional explicit line: *"The cursor-buddy era was adorable. Mine doesn't wait by your cursor. It's already done."*

---

## 4. IDLE's autonomous account — spec (mapped to real code)

The novel, genuinely-yours engine. IDLE narrates its human's life in villain voice, mostly autonomously, with a safety gate.

**How it maps to what exists:**
- **Voice/POV:** persona `soul.md` + `agents/contextBuilder` → the villain register.
- **What to post about:** the background lane's `BgEvent` stream (`task_spawned/tool/done`) + perception observers + dream consolidation = "what I did and noticed today." This is already emitted for the HUD; tee it to a poster.
- **Posting:** Composio X/Twitter toolkit (or a thin `xClient`) via the existing tool path.
- **Safety gate (the wink, mandatory):** route every draft through the **autonomy-tier** flow (`agency/autonomyTier` GREEN→RED) + `agents/loop/approvalWrap`. GREEN (vague "did some admin") auto-posts; ORANGE/RED (anything naming a person, a real detail, or spicy) queues for your one-tap approval. IDLE drafts; a human ships anything risky. This is also a live demo of the safety story.
- **Cadence:** a standing order / scheduled tick (1–3×/day) builds a draft from the day's events.

**New code needed (small):** a `growth/IDLEPoster.ts` that subscribes to `BgEvent` + dream output, drafts in persona, runs the autonomy gate, posts on approve. Days, not weeks — it's a new *surface* on existing subsystems.

**Decision (LOCKED): fully-autonomous posting — but bounded.** IDLE posts unsupervised; the boldness ("we let the AI post whatever it wants") is the story. But full autonomy = hard rails that make a catastrophe *structurally impossible*, not "no rails." A single bad post ends a trust-based brand, and IDLE is fed the founder's real life as material. Guardrails below are mandatory.

### IDLE autonomy guardrails (map to `agency/autonomyTier` + `approvalWrap`)

- **Hard content filter before every post — RED items are dropped, never posted:** no real names or private data of anyone observed; no financial / medical / legal claims; no hate / harassment; no product promises; never post actual screen contents. Deterministic blocklist + a classifier pass.
- **The founder is the ONLY real person IDLE may talk about.** Founder consented and is the subject. Everyone else is off-limits by rule.
- **Posting: fully autonomous. Replying / mentions: GATED at launch.** Replies are where adversarial users bait bots into saying horrific things (Tay, Grok). Let IDLE post freely; gate replies until proven, then loosen and narrate it.
- **Rate caps + kill switch + auto-pause** on anomalous sentiment/engagement spikes.
- **The rails are content.** "I let my AI post whatever it wants — here are the only 5 things it's forbidden to do." The wink: villain energy over visible trust.

---

## 5. Distribution (the Cluely mechanic)

- **Two accounts:** @IDLE (the character/star) + your founder/builder account (the on-ramp + reply-guy). Founder births IDLE.
- **Clip everything** into 15–30s verticals — the orb beat, the villain beat, the grow beat, the unprompted-action beat each become their own clip. Seed TikTok / Shorts / Reels / X.
- **Amplify the fight.** "This is dystopian" vs "I need this NOW" — pin both, answer the dystopian one in IDLE's voice. The argument is the reach.
- **Reply-guy** into Farza's + other Mac-AI threads daily (SOP in the vs-Clicky playbook).

---

## 6. This week's shoot list

- [ ] **Film the Orb teaser** (A) — even via MockDriver if live render isn't ready (be honest it's a preview).
- [ ] **Run one real do-nothing-morning** (B) on a demo Gmail/Calendar with `KAIROS_AUTONOMOUS_ENABLED` — capture the orb + real actions.
- [ ] **Stand up @IDLE + founder account**; ship the first villain post.
- [ ] **Confirm:** is the orb rendering live (daemon-driven) or mock-only right now? (Determines how we frame the teaser.)
- [ ] **Pick the one genuine self-grown skill** for the grow beat (E).
- [ ] **Build minimal `IDLEPoster.ts`** (approved-draft mode) so IDLE's account can run.

---

## 7. Decisions (LOCKED 2026-06-05)

1. **Brand = IDLE-the-character; the Orb is its body** (not a generic "orb logo"). The brand is a watching presence with a villain POV and voice; the orb is how it appears. Differentiate hard from the Siri / Apple-Intelligence shimmer — yours is *an eye with attitude*, not an assistant glow. Reason this is locked all-in: the founder is **screen/hands-only** (below), so a non-human face is required and the orb/IDLE must carry it.
2. **IDLE's account = fully autonomous posting, bounded** by the §4 guardrails (replies gated at launch).
3. **Founder is screen/hands-only** — IDLE + the orb are the face. The do-nothing arc is shot screen-first; the human stays mostly anonymous.

### Still open
4. **Orb teaser:** OK to lead with a mock-driven render (labeled "preview"), or hold for a live daemon-driven capture? (Determines whether we shoot this week or after the live render is confirmed.)

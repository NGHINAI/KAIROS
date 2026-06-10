# 01 — The Thesis & The Trust Ladder (what survived the teardown)

> This is the company. `00-MASTER-PLAN.md` is *how we launch it*; this is *what "it" is*.
> Distilled from a four-round investor teardown. Every line here earned its place by surviving an attack.

---

## The category thesis

**Software is the wrong abstraction. Outcomes are the abstraction.** IDLE is a bet that the next interface isn't apps you operate — it's outcomes you delegate and inspect. The one-liner: **"the end of operating software."** That's a category thesis, not a feature. The risk isn't whether software becomes agentic (it will) — it's whether *IDLE captures the value*. Everything below is about that.

---

## The emotional job: relief — not time, not convenience

Users don't buy time (they waste it freely) or convenience (it gets copied). They buy **relief**: the certainty that *nothing important is dropping*, that their digital life isn't leaking through the cracks. Sell the feeling — "nothing slips" — not the productivity.

**The refinement that resolves the "surrender" problem (the pilot insight):** people don't want the controls *removed*; they want to stop *needing* them while keeping the ability to grab the wheel. So the real job is **relief without loss of control.** Relief comes from trust + reversibility + one-tap intervention — not from being locked out. This is the answer to every "users like touching the controls" objection: IDLE doesn't take the controls away, it makes touching them optional.

---

## The real product is trust accumulation (not the agent)

The agent is table stakes. The product is **the system that earns the right to act unasked, one delegation at a time.** The moment users repeatedly let software act without asking, you haven't built an assistant — you've built a **new interface.** New interfaces are where very large companies come from.

**The one question that *is* the company:**
> What is the minimum set of autonomous actions that causes a user to trust the *next* autonomous action?

Map that sequence and you win. Miss it and you ship a thousand capabilities nobody enables.

---

## The execution graph (the thing that compounds → infrastructure)

A year in, IDLE knows: who matters, which meetings get accepted vs declined, scheduling patterns, vendors, customers, comms habits, recurring workflows, permission topology. That stops being *memory* and becomes **infrastructure.** People rip out apps constantly; they rarely rip out infrastructure.

**But the moat is calibration, not captivity.** "We won't let you export your data" is fragile — regulators kill it, users resent it. The durable version: a competitor *can* import your permissions, integrations, and history. They **cannot import confidence** — that's earned only through successful execution over time. So the switching cost isn't "I can't leave," it's **"I don't want to reset trust to zero."** That survives an export-everything regulation, because the asset was never the data — it was the track record. Open-source the engine if it helps trust; the calibrated confidence is the part that can't be copied or exported.

---

## How we measure it — the three charts, then outcome, then value

Stop caring about model quality, benchmarks, integrations, frameworks. Obsess over three curves moving together:

1. **% of actions reverted → falling toward 0** (it's right)
2. **% of users with autonomy enabled → rising** (they extend trust)
3. **% of actions requiring approval → falling** (trust deepens)

If all three move in the right direction simultaneously, you've discovered **trust accumulation** — the *enabler*, not the product. Trust is necessary, not sufficient (people trust thermostats; nobody pays thermostat multiples). What trust *unlocks* is the real prize:

**The value axis — delegation depth (the 4th chart).** Two users can trust IDLE equally and be worth wildly different amounts. User A lets it archive newsletters; User C lets it coordinate meetings, handle follow-ups, update the CRM, prep briefs, resolve routine issues. The difference isn't trust — it's depth, and depth *is* behavior change. Measure **average delegation depth per user** = breadth (domains) × stakes (reversible → irreversible) × autonomy (approval → unattended). If users aren't climbing it, they're tourists, not customers.

**The engine metric — time to next permission.** Calendar today; how many days until email, then CRM, then the irreversible stuff? This is the *derivative* of delegation depth — it tells you whether trust is **accelerating or stalling**. If it's lengthening, the flywheel is dying. This is the chart on the monitor.

Then the behavioral outcome: **app-disengagement** — days since the user last manually opened their email/calendar/task app, *climbing*. They've stopped operating software.

Then the value proof: **"how disappointed would you be if IDLE vanished"** (target: 40%+ "very disappointed"). Relief is real when its removal hurts.

Stack: trust curves (enabler) → time-to-next-permission (engine velocity) → delegation depth by domain (value) → app-disengagement (behavior) → disappointment (the emotional job confirmed).

---

## The trust ladder (your roadmap is a ladder, not a backlog)

Reframe the roadmap: it's not a feature list, it's an **ordered ladder of delegations**, each rung gated by the trust earned from the one below. **Rung filter:** high-frequency × low-judgment × reversible × obviously-correct — escalating toward lower-frequency / higher-judgment / less-reversible *only* as the three charts prove the rung beneath it.

Candidate ladder (illustrative — the real order must be *discovered* with the first 50, not assumed):

1. **Observe + surface** (zero action): "here are the 5 things that matter today." No risk → earns the right to sort.
2. **Reversible organize**: triage / label / archive obvious noise. Revert is free → earns the right to draft.
3. **Prepare, don't send**: drafts queued, meetings pre-prepped, conflicts flagged. You approve → earns the right to act on the trivial.
4. **Act on the reversible unasked**: archive, decline obvious junk, reschedule within your rules.
5. **Act across apps on the routine**: the multi-app execution — still reversible.
6. → only now, low-frequency / higher-stakes actions, and only after the curves earn it.

**The core IP is discovering the *real* rung order empirically.** That's where the next three months go — not into more capabilities.

---

## The first 50 — measure trust with permissions, not opinions

Don't ask if they like it. **Watch what permissions they grant after 30 days.** People reveal trust with permissions, not surveys. Run week 1 in shadow mode (baseline + the safest rung), then watch the charts per user. The first 50 exist to answer exactly one question: **does trust accumulate — or did we build an impressive demo for a behavior nobody adopts?**

Three things to measure beyond opinions:

- **Time-to-next-permission**, per user, per domain — is it shortening?
- **The day-30 question** (the emotional-job test): *"What are you less worried about now than before you installed IDLE?"* If the answers **converge**, you've found the emotional job and the word-of-mouth story at once. If they scatter, you're still searching. If nobody has an answer, you built technology, not value.
- **The attribution experiment (distribution test).** Counterparties are a **validation** channel, not automatically an **acquisition** one — a clean reschedule reads as "this person is organized," not "what AI did that." Value accrues to the user, not the product. To convert validation into acquisition you need *attribution*, and there's precedent: "Sent via Superhuman," Calendly links, Loom. Test an **opt-in, tasteful attribution surface** on IDLE's outbound actions (the things that land in a counterparty's inbox/calendar). Measure: do users leave it on, and does it generate inbound? That's the difference between "they're organized" and "what scheduled this?" Don't assume curiosity bridges the gap — instrument it.

---

## The expansion staircase (why this is venture-scale, not a $20M utility)

There's a canyon between the beachhead ("I manage your digital chores") and the vision ("the end of operating software"). Most startups die in it. What bridges it isn't the vision — it's the **market-expansion staircase**, drawn as *who*, not features. Each step's deeper delegation produces the trust + cross-person surface that makes the next step reachable. The same engine (trust → depth → shorter time-to-next-permission) climbs every step.

1. **Privacy-trading Mac power users** — the beachhead (people who already installed screen-watching agents). Delegate personal chores.
2. **Solo operators / founders / freelancers** — no assistant, admin costs them money directly, they own the decision to delegate deeply. **← the $20M ARR ceiling sits here. If the staircase stops at step 2, it's a very nice utility, not a fund-returner.**
3. **Coordination across people** — IDLE handles scheduling, follow-ups, and hand-offs *between* a user and their counterparties. Now it touches multiple humans; the surface compounds.
4. **Knowledge workers inside companies (bottoms-up)** — individuals bring it to work the way Superhuman and Linear landed; delegation extends into work tools (CRM, tickets, docs).
5. **The default execution layer for knowledge work** — it sits beneath the apps for whole teams; you state outcomes, it orchestrates the stack. "End of operating software," at org scale.

**The measurable tell for which outcome you're building:** does delegation *cross domains* — personal → interpersonal → professional — and does **time-to-next-permission stay short when it jumps the gap?** If users only ever delegate email, it's a $20M utility (you'll see it early and cheaply). If they climb from personal into work, it's the category. The staircase is a business plan; the vision alone is philosophy, and philosophy rarely returns a fund.

---

## Two honest tensions to manage (do not paper over)

1. **Villain brand vs the relief job.** "Always watching. Good." sells fear-as-flex — excellent for mindshare, *wrong* for the trust the first 50 must extend. Treat the villain voice as **top-of-funnel attention only**; the conversion + retention story is relief + reversibility + control. Don't let fear-marketing repel the exact users who'd climb the ladder. (Two layers, managed consciously.)

2. **Outcome-supervisor vs inspector.** Maybe users never go fully hands-off; maybe they become "people who periodically inspect an autonomous system." That market is *less magical and potentially much bigger.* Don't force the surrender fantasy — build for **inspection + intervention by default**, and let your most-trusting users choose to go hands-off. Design for the pilot, not the passenger.

---

## What NOT to do next (the directive)

Not *"can the agent do more?"* → *"what's the minimum delegation that earns the next one?"* Spend the next three months on the **trust ladder** and the **three charts** — not capabilities. The agent is not the moat. Trust accumulation is.

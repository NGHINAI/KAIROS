# 03 — Guidance overlay rework (Clicky grammar on KAIROS's identity)

Source: the user's 173s recording (System Settings walkthrough), frame-mapped at
`/tmp/clicky-video/`, plus the openclicky overlay models
(`OpenClickyVisualGuidanceOverlayModels.swift`). This file specifies the
affordance system that extends our single comet + pulse-ring, and how it lands in
the existing HUD code.

**House decision (keep our identity, steal the grammar):** we KEEP the
robot-face orb + comet and the rectangle highlight as KAIROS's signature; we make
the transitions seamless/elegant; and we ADD the Clicky affordance vocabulary —
**arrows, scroll guide, region block, bullseye, label pills, and a
buddy-parks-at-target behavior** — rendered in our warm-gold→cyan liquid-glass
material, NOT Clicky's flat saturated red. Similar grammar, not an identical
clone.

This rides on the daemon ⇄ HUD transport documented in 11; everything here is a
new `guide_request.kind` + new SwiftUI shapes, no new socket plumbing.

---

## The Clicky grammar (observed, with timestamps)

| Affordance | When used | Visual spec (as observed) |
|---|---|---|
| **Bullseye** (t≈96–105s) | Single small target: icon, button, sidebar row | Bold red ring(s) circling the element (~1.5× icon size, ~3px stroke), red **label pill** floating adjacent naming it ("Sound"), buddy parked beside. Persists until the user clicks it. |
| **Region block** (t≈54–70, 136–160s) | "Look at this whole section/pane/form" | **Dashed** red rounded-rect border + **translucent fill** (~10–15% alpha wash) + buddy anchored at a corner. Used at every grain: whole content pane (t139), sidebar section (t64), a device table (t157), a single settings row pair (t163). |
| **Scroll guide** (t≈72–80s) | Target offscreen in a scrollable | Vertical **guide-line** along the scrollable's edge + **arrow** + pill at the end with the verb ("scroll down"). PERSISTS while the user scrolls; replaced by the target affordance when it becomes visible. Up/down variants. |
| **Arrow** (implicit, all pointing) | Connect buddy → target at any grain | A directional connector from the parked buddy to the highlight; reads as "look here". The only net-new *geometry* we add beyond the three families. |
| **Label pills** | Naming/instructing anywhere | Capsule, light text, small radius; floats near its subject. |
| **Buddy cursor** (whole video) | Always | Small character with a tiny label; lives on screen permanently; drifts subtly when idle; flies to and PARKS at the corner of the active affordance. It is the attention anchor — the eye follows it to the highlight. |

Color language (Clicky): one saturated red/orange family for ALL guidance; the
OS UI underneath is untouched. Dashed = "region to read"; solid ring = "the exact
thing to click"; pill = words. **KAIROS keeps its warm-gold→cyan gradient as the
identity** (and makes the accent user-pickable via `OverlayCursorColorButton`,
04§F — an accessibility win for red-green colorblind users).

Choreography rules (visible in the video, matching the user's earlier spec):
- State word in the notch changes FIRST (Thinking → Speaking), THEN the
  affordance draws as speech describes it — UI never runs ahead of voice.
- **One affordance family on screen at a time**; grain can change mid-lesson
  (pane block → row block → bullseye) as the explanation narrows.
- Highlights persist across user actions until superseded or the step is done
  (our lesson-session persistence already implements this policy).

---

## Keep our identity (deliberately NOT copied as-is)

- **Robot-face orb + comet stays the centerpiece.** Clicky has no orb; ours is
  the brand. The comet (orb-born, with blinking eyes) IS our "buddy" — we adopt
  the buddy BEHAVIORS (idle drift, park-at-corner, emotes), not the triangle art.
- **The rectangle highlight stays.** Today's `TargetHighlight` (RoundedRectangle,
  warm-gold→cyan, breathing) is kept and repurposed as the point/bullseye
  renderer — we do NOT throw it away for a flat red ring.
- **Seamless/elegant transitions** are a first-class requirement (see the
  Choreography & motion section): spring-in, cross-grain morph, comet glide, and
  retraction must feel continuous, not snap between affordances.
- Our highlight-persistence + auto-continue lesson engine is AHEAD of the video
  (Clicky's pointing is per-instruction; our lessons survive turns and
  auto-resume) — the grammar upgrade rides on top of it.
- Element-index-grounded pointing + act mode (`click_element`) stay; the video
  shows guidance only, no acting.

---

## What we have today vs needed

| Ours today | Gap |
|---|---|
| Comet (Metal-orb-derived glow w/ eyes) flies to target | Keep as the "buddy" — add idle-drift + park-at-corner per affordance kind |
| Single breathing gradient ring on the element rect (`TargetHighlight`, cornerRadius 9, lineWidth 2.4, warm-gold→cyan) | Becomes the **bullseye/point** renderer; add a ring+label-pill composite |
| `CaptionPill` (glass) | Add a glass **action-pill** variant for verbs ("scroll down", "click here") distinct from the element-name label pill |
| Nothing for regions | NEW: dashed rounded-rect + alpha fill over any rect union |
| Nothing for scrolling | NEW: edge guide-line + arrow + action pill; needs scroll-container detection |
| Nothing connecting buddy → target | NEW: shared **arrow** affordance from parked comet to highlight |
| `guide_end` retraction + lesson persistence | Unchanged — policies carry over |

---

## Protocol changes (daemon ⇄ HUD) — see 11 for transport

Extend `guide_request` with an affordance `kind` instead of point-only. `kind`
defaults to `"point"` so EVERY existing caller and verifier gate is unchanged.

```jsonc
guide_request {
  id, app,
  kind: "point" | "region" | "scroll" | "label",   // default "point"
  // point:  element | find       → bullseye + label pill + buddy park + arrow
  // region: elements:[N,...] | find_all  → union rect → dashed block + fill
  // scroll: { container_hint, direction:"up"|"down", until:<find> } → guide-line + arrow + pill
  // label:  rect | element + text only (no ring)
  label?: string,          // pill text (defaults to resolved element title)
  arrow?: boolean          // draw the connector from buddy → target (default true for point/region)
}
```

The HUD answers with the same id-keyed `{cmd:"guide_result", id, found, label,
reason, summary}` as today (11§3). The new scroll round-trip answers with
`{cmd:"scroll_result", id, ...}`.

### Daemon tool surface (`guideTools.ts`)

- `guide_user` gains `style:"point"|"region"|"label"` and accepts `elements:[N..]`
  for regions. Verifier gates unchanged — **a successful region highlight counts
  as "Pointing at"** (so the false-blindness / false-done gates don't misfire on
  multi-element guide calls; the toolCallLedger evidence shape must carry the
  union/element set — see 11§8 / 05).
- NEW `guide_scroll({ direction, until, app })`: draws the scroll affordance and
  internally runs `wait_for_screen(until)` so the lesson auto-advances when the
  target scrolls into view (the video shows exactly this loop). This reuses the
  existing `handleWatch` poll loop (`GuideModel.swift:95-120`) — just wire
  `guide_scroll` to it; no new polling machinery.
- `read_screen` additions for regions/scroll — AXFinder must additionally report
  (per 05§A):
  - **(a)** the **union rect** of a group (we already climb to container parents
    in act mode — reuse that container-climb): `unionFrame(of:[indices/labels])`.
  - **(b)** the nearest **scrollable ancestor** (`AXScrollArea` role + its frame,
    and whether the target is above/below the viewport): `scrollableAncestor(of:)`
    so the guide-line knows which edge to hug and which arrow direction to draw.
  These are additive helpers on the existing AX walk; the numbered element-index
  snapshot stays the addressing contract so guide-by-number, act-mode
  confirm-gate, and change-detection are untouched.

---

## HUD implementation (KairosHUD)

### `GuideModel`

Replace the single `target: GuideTarget?` (which today holds only `{rect,label}`)
with an `affordance: Affordance` enum, and parse the new `guide_request` fields in
`handle(...)`:

```swift
enum Affordance {
    case point(rect: CGRect, label: String?)          // bullseye + pill (+ arrow)
    case region(rect: CGRect, label: String?)          // dashed block + fill
    case scroll(edgeRect: CGRect, direction: ScrollDir, label: String)  // guide-line + arrow + pill
    case label(rect: CGRect, text: String)             // pill only, no ring
}
enum ScrollDir { case up, down }
```

- Keep `GuidePhase { hidden, active, returning }` and `cometPos` as-is.
- **Comet park-position derives per kind**: beside the ring (point), the
  top-left corner of the rect (region), the pill tip / edge end (scroll).
- Add a `handleScroll`/`guide_scroll` entry that reuses the existing
  `handleWatch` poll loop for auto-advance.
- **Idle buddy:** when no lesson/affordance for >N s but a voice session is
  active, the comet drifts in a slow Lissajous near a screen edge instead of
  instantly re-forming the orb (toggleable; ties into 04's docked-buddy mode and
  the "permanent presence" Clicky behavior).

### `GuideOverlayView`

KEEP `GuideComet` (robot-face, blinking eyes, spring) and `TargetHighlight`
(rectangle, warm-gold→cyan) — repurpose `TargetHighlight` as the bullseye/point
renderer. Add four new SwiftUI views, all rendered in the existing full-screen
click-through guide panel (no new window plumbing):

- **`BullseyeRing`** — solid stroke circle (or the kept RoundedRectangle for
  larger targets), springs in `1.3×→1.0` scale, gentle pulse while waiting. Pairs
  with the label pill and the arrow.
- **`RegionBlock`** —
  `RoundedRectangle(cornerRadius: 12, style: .continuous)`,
  `StrokeStyle(lineWidth: 2.5, dash: [7, 5])` with a slowly animating `dashPhase`
  (the "marching ants" alive feel), `.fill(accent.opacity(0.12))`. Comet parks at
  the rect's top-left corner. Driven by `AXFinder.unionFrame(of:)`.
- **`ScrollGuide`** — a `Capsule` guide-line hugging the scrollable's edge (full
  scroll-axis length, ~3pt), an arrowhead, and an action pill ("scroll down")
  with a subtle directional shimmer. Persists while scrolling; replaced by the
  resolved target affordance when `until` matches. Requires
  `AXFinder.scrollableAncestor(of:)`.
- **`ArrowAffordance`** (net-new geometry) — a small reusable connector
  (`Capsule` line + arrowhead) drawn from the parked comet to the highlight;
  shared by point/region/scroll. This is the cheapest high-impact addition and
  the only genuinely new shape requested — render it in the same click-through
  panel.

Plus an action-pill variant of `CaptionPill`: a glass capsule for VERBS ("scroll
down", "click here") distinct from the element-name label pill — both stay on
glass to keep KAIROS's material language rather than Clicky's flat capsules.

### Choreography & motion (the "seamless/elegant" requirement)

- **Spring-in, not snap:** affordances appear with the `1.3×→1.0` scale spring
  (matches `BullseyeRing`); `RegionBlock` fades its fill in over ~0.18s while the
  dashed border draws.
- **Cross-grain morph:** when the grain narrows mid-lesson (pane → row →
  bullseye), the previous affordance's rect SPRINGS to the new rect rather than
  hiding+redrawing — one continuous motion (interpolate the rect; swap the
  renderer only when the kind changes, and even then cross-fade ~0.15s).
- **Comet glide:** the comet glides to its new park-position on the existing
  `cometPos` spring; the arrow re-anchors continuously as it moves.
- **Voice-led timing:** affordance draw is gated on the speech describing it
  (notch word flips first, 04§A) — the overlay never runs ahead of the voice.
- **One family at a time:** because `affordance` is a single slot, only one
  family is ever on screen; mid-lesson grain changes mutate that slot (no
  overlapping highlights — preserves the "UI never runs ahead of voice"
  contract).
- **Elegant retraction:** on `guide_end`, the affordance shrinks/fades and the
  comet returns to the orb (or, if a voice session is still active and idle-drift
  is on, settles into the Lissajous drift instead of fully re-forming).

### `DaemonClient` (transport)

In the `guide_request` case (`DaemonClient.swift:303`), forward the new `kind` +
region/scroll fields to `GuideModel`. Add a `guide_scroll` / `scroll_result`
round-trip mirroring `sendGuideResult`. The orb-state cases need NO change — the
guidance upgrade and the Codex swap are both invisible here by design (11§5).

---

## AXFinder gaps to close (prerequisite — 05§A)

AXFinder today has **no** scroll-area detection and **no** group/union-frame
support (verified: zero matches for `ScrollArea|union|climb` in `AXFinder.swift`).
Region and scroll affordances can be built in SwiftUI first but will have nothing
to point at until these ship — sequence the AX work alongside (not after) the
overlay work:

- `unionFrame(of: [labels/indices]) -> CGRect` — group/region rect via the
  existing act-mode container-climb.
- `scrollableAncestor(of:) -> (frame: CGRect, axis, targetAbove/Below)` — nearest
  `AXScrollArea`, its frame, and the target's relation to the viewport.

Both keep the numbered inventory snapshot as the addressing contract.

---

## Per-request timeouts (don't break the round-trip)

The guide round-trip relies on the HUD answering within per-request timeouts
(8s/12s/15s, `guideBridge` `roundTrip`) or the agent concludes "the HUD isn't
running". Region/scroll resolution (union-rect walks, scrollable detection,
scroll-and-wait) can take longer — **tune timeouts per `kind`** (scroll's
`until` wait especially needs a longer budget than a point resolve).

---

## Sequencing within Phase B

1. `Affordance` enum + `ArrowAffordance` + repurpose `TargetHighlight` as
   bullseye (pure SwiftUI, no AX dependency) — immediate visible upgrade.
2. AXFinder `unionFrame` → `RegionBlock` wired end-to-end.
3. AXFinder `scrollableAncestor` → `ScrollGuide` + `guide_scroll` reusing
   `handleWatch`.
4. Choreography polish (cross-grain morph, idle Lissajous, action-pill variant).

Everything behind the existing guidance path; nothing changes the orb-state
machine or the Codex seam (11).

# Full computer control (2026-06-10)

KAIROS went from "points at things" to "actually does things." Four capability
layers, all screenshot-free (the fast path — Cua is slow because of screenshots+
VLM, NOT actuation; AX press is sub-millisecond, confirmed by recon).

## The layers (narrowest route first)
1. **AX press** — `click_element(find, app?)` (HUD): resolves the element via the
   accessibility tree, the comet flies to it, then `AXUIElementPerformAction`
   (kAXPress → confirm → pick → open → showMenu) activates it. No cursor move, no
   focus steal. Works in native apps AND Safari/Chrome web pages. LIVE-VERIFIED:
   "click Accessibility in System Settings" → real AX press succeeded.
2. **run_applescript** (daemon): the best path for system + app actions — system
   volume (`set volume output volume N`), Spotify/Music (`set sound volume`,
   `playpause`, `next track`), Safari URLs, Notes/Mail, generic UI via System
   Events. LIVE-VERIFIED: "set volume to 40 percent" → actual system volume = 40.
3. **run_shell** (daemon): the universal escape hatch for anything else.
4. **open_app**: launches/focuses an app (argv `open -a`); click_element/guide_user
   self-heal by calling it when the target app isn't running.

## Safety (user opted into a hands-on assistant — no per-action prompts)
- Destructive shell/AppleScript is HARD-REFUSED inside the tool (never run, never
  gated): `isDestructiveShell` (shared with the background lane) blocks rm -rf, dd,
  mkfs, diskutil erase, raw block-device writes, sudo, shutdown/reboot, killall,
  launchctl/crontab, fork bombs, pipe-to-shell, shell-rc edits. AppleScript that
  `do shell script`s a destructive command is caught too.
- Everything non-destructive runs WITHOUT an approval prompt (the four tools are in
  the verifier's LOCAL_TOOLS). Env kill-switches: KAIROS_COMPUTER_CONTROL=0.
- Fixed a real denylist bug: `>/dev/null` (ubiquitous, safe) was matching the
  raw-device-write pattern; now only `/dev/disk0`/`/dev/sda`-style block devices match.

## Safari / web
WebKit exposes web content in the AX tree (`AXWebArea` → AXLink/AXButton/AXTextField
with real frames). AXFinder reaches it with no changes — LIVE-VERIFIED finding +
pointing at a web button/link by visible text. CAVEATS: only the ACTIVE tab is in
the tree (background tabs aren't rendered → not clickable, which is correct); and
Safari with many heavy tabs + not-frontmost has focus ambiguity. Mitigations:
focused/main window walked first, then all windows, each with its OWN time+node
budget (a heavy Twitter tab can't starve the test-page window); per-call AX
messaging timeout raised 0.3s→1.0s (heavy web areas returned empty children at 0.3s);
total walk cap 5s < the 8s bridge timeout. Chrome/Electron need
AXEnhancedUserInterface on the pid — future tier.

## The recurring villain (worth remembering)
Every failed test reply ("I can't click that right now", "not seeing it") got
MEMORIZED, then FTS-recalled on the next identical ask, priming the fast front to
REFUSE conversationally instead of routing to the tool — so the tool never ran.
Fixed by extending FAILURE_ECHO_RE (can't click/press/do-that, clicking isn't
available, …) on BOTH the recorder (voiceObservation) and injection (isSelfEchoMemory)
sides, + quarantining the accumulated rows. This bit us across MULTIPLE sessions;
the general lesson: a self-refusal is never a fact about the world.

## Ops gotcha (cost me many cycles)
`lsof -ti:9876` lists CLIENTS too — killing it nukes the HUD/Electron. Kill the
listener only: `lsof -ti:9876 -sTCP:LISTEN | xargs kill -9`. And restart in order:
daemon fully up → THEN the HUD (the HUD connects once; churning the daemon under it
leaves it talking to a dead socket until reconnect). Per-launch AX state is real.

## Verified
agents 381 · llm/connectors/skills 295 · voice 86 (+1 pre-existing boot-timeout).
Swift HUD + daemon build clean. Live: volume→40, click Accessibility (AX press ok),
Safari web button found, Spotify/media via applescript. New unit suites:
controlTools.test.ts (11), guideBridge.test.ts click_element cases.

## Flags / env
KAIROS_COMPUTER_CONTROL=0 (disable shell+applescript) · KAIROS_AX_DEBUG=1 (HUD logs
AX walk misses + request routing) · `KairosHUD --axprobe "<label>" "<App>"` dumps
the walk for debugging a target.

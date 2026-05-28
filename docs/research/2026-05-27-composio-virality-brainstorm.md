# Composio Virality Brainstorm — KAIROS Phase C.2.7
> 2026-05-27
> Scope: Pre-execution brainstorm for virality angle on Phase C.2.7 (Composio Connectors).
> Prior research already covered: SDK correctness (full-docs-walk), trigger architecture (triggers-proactivity), plan correctness (c2-7 plan). This doc focuses exclusively on VIRALITY — what makes someone say "you have to see this."

---

## Section A: Composio Feature Catalog Beyond Basic Tool-Calling

### A1. Built-in Meta-Tools (COMPOSIO_* prefixed)

These appear in every session automatically when `manageConnections: true` (the default). They are not Composio integrations — they are meta-capabilities the LLM can call to manage its own tool environment.

| Meta-tool | What it does | KAIROS viral use case | Effort & phase |
|-----------|-------------|----------------------|----------------|
| `COMPOSIO_MANAGE_CONNECTIONS` | When LLM needs a toolkit that isn't connected, it calls this tool, gets back a Connect Link URL, and surfaces it to the user | The "5-second setup" hook — agent voice-announces the need and auto-opens the browser. Already in C.2.7 Path B. | Already planned. Zero extra effort. |
| `COMPOSIO_MULTI_EXECUTE_TOOL` | Chains multiple tool calls in a single LLM request. The agent can execute a sequence of cross-service actions in one turn without multiple round-trips. | "Send my meeting notes to Sarah on Slack, create a Linear issue for the action items, and email the recap to my boss" — all in one voice command, one LLM turn. The demo moment. | Already available free. Needs zero code. The *prompt* must just not instruct the agent to execute tools one-at-a-time. |
| `COMPOSIO_SEARCH_TOOLS` | Agent can call this to discover what tools are available for a given query. Returns matching tools from the full Composio catalog, filtered to the user's connected toolkits + any others discoverable. | "What can you do with my GitHub?" → agent calls `COMPOSIO_SEARCH_TOOLS(query='github')` → reads back a voice summary of capabilities. The "knows your apps better than you do" hook. | Already available free. Needs intent wiring (~2h). |
| `COMPOSIO_REMOTE_WORKBENCH` | Python sandbox persistent across the session. Agent can execute Python code. | NOT useful for KAIROS. Must be disabled via `workbench: { enable: false }` or it pollutes the tool list. | SKIP entirely. Already in plan. |
| `COMPOSIO_REMOTE_BASH_TOOL` | Execute bash commands in the remote sandbox. | NOT useful for KAIROS — KAIROS already has local bash access if needed. Pollutes tool list. | SKIP. Disabled by `workbench: { enable: false }`. |

**Key insight from prior research:** The three genuinely viral meta-tools (MANAGE_CONNECTIONS, MULTI_EXECUTE, SEARCH_TOOLS) are all free and already present in every session with default settings. The plan must NOT accidentally disable them. The only change needed is to make sure KAIROS's LLM system prompt does NOT suppress multi-tool execution (don't tell the model to "do one thing at a time").

---

### A2. Custom Tools

**What it does:** `experimental_createTool()` lets you inject KAIROS-native functions into Composio's tool catalog. The LLM sees them alongside Slack, Gmail, GitHub tools.

**Key constraint from docs:** Custom tools work with `session.tools()` (native mode) only. MCP support is "coming soon." This means if KAIROS uses session.mcp.url for tool routing (current plan), custom tools are NOT available via that path.

**KAIROS use cases if native mode were used:**
- `KAIROS_CREATE_TASK` — agent can create a KAIROS task from within a cross-service workflow
- `KAIROS_SCHEDULE_REMINDER` — during a multi-step workflow, agent can also set a follow-up reminder
- `KAIROS_NOTE_TO_SELF` — agent captures something to KAIROS's own memory mid-workflow

**Viral angle:** Agent executing a 5-step workflow that includes saving something back to KAIROS itself. The AI working with itself.

**Effort & phase:** L — requires switching from MCP path to native tools path, which is an architectural change. DEFER to C.2.9 or a future phase when Composio ships custom tools via MCP.

---

### A3. Custom Toolkits

**What it does:** `experimental_createToolkit()` lets you define entirely new third-party services not in Composio's 500+ catalog. You provide the API schema, auth details, and tool definitions. They become first-class members of the catalog.

**KAIROS use cases:**
- User has an internal CRM or ticketing system not in Composio's catalog
- CertusAI integration — a restaurant's POS system as a KAIROS toolkit
- Any niche vertical app

**Viral angle:** "I connected my obscure internal tool and KAIROS just started using it." Demo video: user adds a custom internal API in 2 minutes by voice-describing the endpoints.

**Same MCP constraint applies.** Custom toolkits only work in native mode. Same architectural prerequisite as A2.

**Effort & phase:** XL — plus blocked on Composio shipping custom toolkits via MCP. SKIP for C.2.7, note as future roadmap.

---

### A4. Pre/Post Processors (Modifiers)

**What it does:** `beforeExecute`, `afterExecute`, `modifySchema` hooks that intercept tool calls. You can transform inputs before they reach Composio's API, and transform outputs before they reach the LLM.

**Key constraint from docs:** Only available in direct execution mode. NOT available in session/MCP mode. This is confirmed in the full-docs-walk.

**Hypothetical KAIROS use cases (if available):**
- `modifySchema` — strip sensitive fields from tool schemas so the LLM can't leak them
- `afterExecute` — auto-log every tool execution to KAIROS's audit trail
- `beforeExecute` — add user context to every tool call automatically (e.g., "from KAIROS user: nirmal@certus-ai.com")

**Verdict:** Not applicable for C.2.7's MCP approach. Skip entirely.

---

### A5. Files Mount (Workbench Files)

**What it does:** The workbench sandbox (the Python environment) has a mounted filesystem that the LLM agent can read/write. The agent can upload files to the workbench, process them with code, and get results back.

**KAIROS use cases:**
- "Summarize this PDF on my desktop" — KAIROS copies the file to the workbench FS, LLM executes Python to extract/summarize
- "Analyze this spreadsheet" — same pattern
- "Turn this Markdown file into a properly formatted email" — LLM reads file, transforms, sends via Gmail

**Critical constraint:** Files mount is PART of the workbench. The plan disables the workbench (`workbench: { enable: false }`). If KAIROS wants file processing, it must enable the workbench selectively.

**Viral angle:** "Summarize the PDF on my desktop" by voice — KAIROS drags the file into Composio's sandbox and gets back a summary. Zero third-party PDF API needed.

**Effort & phase:** M — requires enabling the workbench (reverse the disable), uploading the file to the remote sandbox, and having the LLM process it. But Composio's sandbox is remote and not billed yet. Could be a sharp viral demo.

**Revised recommendation:** Consider enabling workbench for FILE operations only, but restrict via prompt so the LLM doesn't misuse COMPOSIO_REMOTE_BASH_TOOL for arbitrary system commands. This is a C.2.8 candidate.

---

### A6. Triggers (Deferred to C.2.8)

Fully cataloged in `2026-05-27-composio-triggers-proactivity.md`. Reproducing the catalog here for completeness:

| Toolkit | Trigger count | Real-time? | Best trigger for virality |
|---------|--------------|------------|--------------------------|
| Gmail | 2 | No (≥15 min polling) | `GMAIL_NEW_GMAIL_MESSAGE` |
| Slack | 8 | Yes | `SLACK_NEW_MESSAGE` |
| GitHub | 20 | Yes | `GITHUB_COMMIT_EVENT`, `GITHUB_ISSUE_CREATED` |
| Google Calendar | 7 | Likely no | `GOOGLECALENDAR_NEW_EVENT` |
| Notion | 13 | Yes | `NOTION_ALL_PAGE_EVENTS_TRIGGER` |
| Linear | 3 | Yes | `LINEAR_ISSUE_CREATED_TRIGGER` |

**Most viral trigger combination for a demo:** GitHub + Slack. "When anyone opens a PR on my repo, message my team on Slack with the PR title and link." Real-time, fully automatic, zero configuration after setup. This is the "I set it up in 10 seconds and it just works forever" hook.

**Effort & phase:** L for C.2.8 (full TriggerListener + MonitoringIntentHandler). But worth flagging that the DEMO for this will be extraordinary.

---

### A7. Sessions — Beyond MCP Routing

Sessions offer more than a URL. Under-explored in the plan:

**`session.toolkits()` (read-only query):** Returns each toolkit with its connection status. KAIROS can call this to render a real-time "what's connected" list. Voice: "What apps am I connected to?" → agent calls `session.toolkits()` → reads back the list. This is a natural demo moment.

**Session persistence:** Session IDs are stable across daemon restarts. The current plan handles this correctly (ComposioSessionManager resumes via `composio.use(sessionId)`). The viral angle: "KAIROS remembers everything" — you restart the daemon and all your connected apps are still there, tools are ready.

**`session.update()` for dynamic toolkit addition:** User says "also connect my Notion" mid-session → KAIROS calls `session.update({ toolkits: [...existing, 'notion'] })` → new tools appear in the MCP list immediately, without restarting. No configuration reload. This feels magical: you speak an app name and it's immediately available.

**Effort & phase:** Zero for session persistence (already planned). ~2h for "what apps am I connected to?" voice intent. Zero for dynamic toolkit addition (already planned via addToolkit).

---

### A8. Tool Tags (readOnlyHint, destructiveHint)

**What it does:** MCP spec allows servers to annotate tools with hints: `readOnlyHint: true` (tool doesn't modify state), `destructiveHint: true` (tool deletes/overwrites data), `idempotentHint: true` (safe to retry).

**Whether Composio surfaces these:** Not confirmed from docs. The MCP spec supports them; Composio may or may not pass them through in `session.mcp.url`.

**KAIROS use cases:**
- Tier classification: `readOnlyHint` tools don't need user confirmation; `destructiveHint` tools should require a voice confirmation before executing
- "Are you sure?" moment: "I'm about to delete this GitHub issue. Say yes to confirm." Only triggers for destructive tools.

**Viral angle:** The "AI that asks before it deletes" moment. Users love seeing that KAIROS won't blindly execute destructive actions. This builds trust and is highly shareable ("look, it double-checks before deleting").

**Effort & phase:** S — read `toolAnnotations` from MCP tool list, add a `DestructiveToolGuard` that intercepts tool calls where `destructiveHint: true` and requires a voice confirmation before proceeding. Composio may not surface these hints yet, but KAIROS can implement its own static list of known-destructive tool name patterns (e.g., `*delete*`, `*remove*`, `*archive*`).

**Phase:** C.2.7 (lightweight addition, purely in KAIROS's tool-call pipeline).

---

### A9. Tool Versions

**What it does:** Composio may allow pinning specific versions of toolkit integrations. Not confirmed in depth from docs.

**KAIROS use cases:** Stability. If Composio upgrades a GitHub toolkit and changes a tool schema, pinned versions prevent breakage. This is ops hygiene, not viral.

**Verdict:** SKIP for virality. Engineering concern only.

---

### A10. MCP Multi-App Servers

**What it does:** Composio's `composio.mcp` (the standalone `mcp` object, distinct from `session.mcp`) allows creating named, persistent MCP server configurations that can serve multiple toolkits to multiple users. The `generate()` method creates per-user server URLs from a named config.

**Distinction from session.mcp:** `session.mcp.url` is ephemeral (tied to a session). `composio.mcp` configs are project-level persistent configurations. Think of them as "MCP server templates."

**KAIROS use case:** In Phase F (Cloud), KAIROS could pre-create named MCP server configs for common toolkit bundles (e.g., "productivity suite" = Gmail + Calendar + Notion + Linear) and generate per-user URLs from them without creating sessions. This could reduce session management overhead at scale.

**Viral angle:** None directly. This is infrastructure optimization.

**Phase:** F or skip. No C.2.7 value.

---

### A11. Sandbox Compute Tiers

**What it does:** The `workbench.sandboxSize` parameter accepts `'standard' | 'medium' | 'large' | 'xlarge'`. Different CPU/RAM for the remote Python sandbox.

**KAIROS use case:** If KAIROS enables the workbench for file processing (Section A5), large PDFs or data analysis would benefit from larger sandbox sizes.

**Phase:** Only relevant if workbench is enabled. Defer with workbench decision.

---

### A12. Connected Account ACL / Shared Connections

**What it does:** Composio's shared connections allow multiple users to share one authenticated account (e.g., team Slack workspace, team GitHub org).

**KAIROS use case:** Phase F enterprise — a team where everyone shares one Slack bot connection or one GitHub org connection. Single OAuth, multiple KAIROS users benefit.

**Viral angle:** None for individual use. Enterprise feature.

**Phase:** F.

---

### A13. `composio.connected_account.expired` Webhook (vs. polling)

**What it does:** Composio fires a webhook when an OAuth refresh token is revoked or expires. Subscribe via `POST /api/v3.1/webhook_subscriptions`.

**KAIROS use case:** Replace the 5-minute polling `TokenExpiryPoller` with a real-time webhook event. Detected in the full-docs-walk (Amendment 8/21).

**Viral angle:** None. Infrastructure reliability improvement.

**Phase:** F (requires Cloud). Not C.2.7.

---

### A14. `connectedAccounts.refresh()` — Explicit Token Refresh

**What it does:** `await composio.connectedAccounts.refresh(connectedAccountId, { validateCredentials?: boolean })` — forces a token refresh.

**KAIROS use case:** If a user reports a tool failing, KAIROS can proactively refresh credentials before asking the user to reconnect. Reduces reconnect friction.

**Viral angle:** Low directly, but contributes to "it just works, never breaks" perception.

**Phase:** C.2.7 patch — add as a fallback in `TokenExpiryPoller`'s error recovery path. S effort.

---

## Section B: Viral Hook Analysis

### Hook 1 — "Setup in 5 seconds"

**Description:** User says "connect my GitHub" → KAIROS announces it → browser opens → user clicks Allow → 5 seconds later, KAIROS confirms GitHub is ready.

**Composio features enabling this:**
- `session.authorize(toolkit, { callbackUrl })` — gets the auth URL
- `OAuthCallbackHandler` (C.2.5, reused) — captures localhost redirect
- `connectionRequest.waitForConnection()` — confirms ACTIVE without manual polling
- `COMPOSIO_MANAGE_CONNECTIONS` meta-tool — enables agent-initiated version (Path B)

**Effort:** S (already in C.2.7 plan)
**Viral potential:** 9/10 — the "one voice command to connect an app" moment is extremely shareable
**Phase:** C.2.7 — already planned. The viral element is the VOICE + AUTO-OPEN combination, not the API. The plan should explicitly call out that the agent speaks first AND opens browser simultaneously (no "please say yes to confirm" round-trip — that kills the magic).

---

### Hook 2 — "Voice → multi-app workflow in one command"

**Description:** "Send my meeting notes to Sarah on Slack, create a Linear issue for the action items, and email the recap to my boss." One voice command → 3 services touched → done.

**Composio features enabling this:**
- `COMPOSIO_MULTI_EXECUTE_TOOL` — chains tool calls in one request without multiple LLM round-trips
- Session already has Slack + Linear + Gmail toolkits active

**Critical insight:** `COMPOSIO_MULTI_EXECUTE_TOOL` already exists in every session for free. But the current plan doesn't explicitly surface it or test that the LLM knows to USE it for multi-step tasks. The LLM will use it naturally IF the system prompt doesn't constrain it to single-action execution, and IF the LLM knows `COMPOSIO_MULTI_EXECUTE_TOOL` exists.

**What's actually needed:** The KAIROS system prompt for the agency layer should explicitly mention: "When the user's request spans multiple services, use COMPOSIO_MULTI_EXECUTE_TOOL to chain the operations efficiently rather than executing them sequentially." This is a prompt change, not a code change.

**Effort:** S — one system prompt addition + one demo scenario in tests
**Viral potential:** 10/10 — the "I just said one thing and it did 5 things across 5 apps" moment is THE killer demo
**Phase:** FOLD INTO C.2.7. Zero infrastructure change needed. System prompt + test only.

---

### Hook 3 — "It discovers tools as it needs them"

**Description:** User asks for something KAIROS hasn't explicitly been given: "Post a summary of my week to my Notion daily journal." KAIROS doesn't know the Notion toolkit's tools by name — but COMPOSIO_SEARCH_TOOLS does. Agent calls it, discovers `NOTION_CREATE_PAGE`, uses it. The user perceives KAIROS as knowing about every app in existence.

**Composio features enabling this:**
- `COMPOSIO_SEARCH_TOOLS` — agent discovers tools by description query
- Session already includes all connected toolkits' tools

**What's actually needed:** KAIROS's system prompt must include: "When you're unsure what tool to use, call COMPOSIO_SEARCH_TOOLS with a description of what you need before defaulting to 'I can't do that.'" This prevents the LLM from refusing tasks where the tool exists but isn't in the top-of-context list.

**Complementary voice intent — "What can you do with X?":** User says "What can you do with my GitHub?" → KAIROS calls `COMPOSIO_SEARCH_TOOLS(query='github')` → synthesizes a brief voice summary of top capabilities → speaks it back. This is a concrete, demo-able feature that requires ~3h of intent wiring:
1. New `DiscoverToolsIntent` handler that recognizes "what can you do with [app]?" patterns
2. Calls `COMPOSIO_SEARCH_TOOLS` via the LLM or directly
3. Formats the result as a 3-sentence voice summary
4. Speaks it back

**Effort:** S (prompt change) + M (DiscoverToolsIntent handler for the proactive "what can you do?" use case)
**Viral potential:** 8/10 for the autonomous discovery during a task; 7/10 for the explicit "what can you do?" query
**Phase:** C.2.7 — the prompt change is zero cost. DiscoverToolsIntent is a small addition (~2h) worth folding in.

---

### Hook 4 — "Knows your apps better than you do"

**Description:** After connecting GitHub, KAIROS proactively tells you: "I'm now connected to GitHub. I can create issues, review PRs, merge branches, and manage releases. Want me to show you what's open right now?"

**Composio features enabling this:**
- `COMPOSIO_SEARCH_TOOLS` — called immediately after a new connection is made
- Session dynamically updated with new toolkit

**What's actually needed:** In `ConnectionFlow`, after a successful connection, KAIROS:
1. Calls `COMPOSIO_SEARCH_TOOLS(query='{toolkit_slug}')` in the background
2. Formats the top 3-5 capabilities as a voice announcement
3. Speaks: "GitHub connected. I can now [top 3 things]. Want to [suggested first action]?"

This is the "onboarding moment" that makes users feel KAIROS is alive and curious about their tools, not just a passive tool-executor.

**Effort:** S — 20 lines of code in `ConnectionFlow.connect()`. Call `COMPOSIO_SEARCH_TOOLS` after `waitForConnection()` resolves, format result, emit to voice layer.
**Viral potential:** 8/10 — the "my AI introduced itself to my GitHub account" moment
**Phase:** FOLD INTO C.2.7. This is the completion of Path A's UX — currently the plan just says "KAIROS speaks: Gmail connected." This makes that moment richer.

---

### Hook 5 — "Cross-service smarts"

**Description:** Agent notices patterns across services. "I noticed your Linear issue mentions Sarah — want me to look her up on Slack and check if she's available?"

**Composio features enabling this:**
- Multiple toolkits active in session simultaneously
- LLM naturally cross-references entities across tool results
- `COMPOSIO_MULTI_EXECUTE_TOOL` to act on the inference

**What's actually needed:** This emerges naturally from the multi-toolkit session — the LLM will make cross-service connections IF it has context from multiple services at once. The viral moment is not engineered; it emerges from the combination of rich tool availability + a powerful LLM. No Composio-specific feature beyond "multiple connected toolkits."

**Key architectural decision that enables this:** When KAIROS starts a session, it should load ALL of the user's connected toolkits (not just the ones relevant to the current task). If the user has Slack + Linear + GitHub + Gmail all connected, all their tools are in the LLM's available set. The LLM naturally correlates.

**Effort:** Zero (already planned) — the virality comes from the architecture, not new code. The plan's `default_toolkits` already loads all connected toolkits.
**Viral potential:** 7/10 — this requires the right query to trigger it; can't be reliably demo'd on demand
**Phase:** Already in plan. Ensure default_toolkits includes ALL connected toolkits, not just a subset.

---

### Hook 6 — "Custom skills you teach it"

**Description:** "Every Monday, summarize my GitHub PRs to my Notion daily journal." User says it once, KAIROS remembers and executes weekly.

**Composio features enabling this:**
- Triggers (C.2.8) — time-based trigger for Monday morning
- `COMPOSIO_MULTI_EXECUTE_TOOL` — chains GitHub PR list + Notion page creation in one execution
- KAIROS's existing STANDING_ORDERS system (already in C.1) — the memory layer

**Key insight:** The STANDING_ORDERS system already exists in KAIROS (Phase C.1). Composio's tools are just the execution mechanism. KAIROS needs to interpret "every Monday" as a STANDING_ORDER that fires a Composio multi-tool execution. The composition is:
```
Monday trigger (KAIROS cron or Composio time trigger) 
  → COMPOSIO_MULTI_EXECUTE_TOOL([github_list_prs, notion_create_page]) 
  → result → voice announcement
```

**Effort:** M for C.2.8 (need scheduled triggers — Composio may have a time-based trigger; if not, use KAIROS's existing cron + Composio for the execution). The STANDING_ORDERS → Composio bridge is the new piece.
**Viral potential:** 9/10 — "I told my AI to do something once and it's been doing it every week" is the holy grail of productivity AI virality
**Phase:** C.2.8 (requires trigger-like scheduling). But the "I told KAIROS to do this once" moment should be hinted at in C.2.7 demos even if the actual scheduling is deferred — show a manually triggered version first.

---

### Hook 7 — "It builds tools on the fly"

**Description:** User says "I need to check the weather every morning." KAIROS uses Custom Tools to create a `morning_weather` tool.

**Reality check:** Custom tools in Composio are developer-defined at build time, not runtime-created via voice. The user cannot voice-define a new Composio tool. `experimental_createTool()` is a build-time API.

**What KAIROS CAN do instead:** KAIROS's STANDING_ORDERS (already built) effectively creates persistent behaviors. The viral hook is already partially achievable: "I need weather every morning" → STANDING_ORDER: every 8am, call a weather API tool (if KAIROS has a weather toolkit connected) and announce the forecast. No new Composio Custom Tools work needed.

**Effort:** Low (use existing STANDING_ORDERS + existing Composio weather tool if available)
**Viral potential:** 6/10 — less impressive once you understand how it works
**Phase:** C.2.8. Note that the "build tools on the fly" framing is misleading — the actual mechanism is simpler (STANDING_ORDERS + existing tools). Don't over-engineer this hook.

---

### Hook 8 — "Files just work"

**Description:** "Summarize this PDF on my desktop" — KAIROS uses the Composio workbench filesystem to process it.

**Composio features enabling this:**
- Workbench files mount (requires `workbench: { enable: true }` — reverses current plan)
- `COMPOSIO_REMOTE_WORKBENCH` meta-tool — LLM executes Python to read/process the PDF
- macOS file access — KAIROS reads local file → uploads to workbench

**What's actually needed:**
1. Reverse the `workbench: { enable: false }` decision for file-processing sessions (or have two session types: standard with workbench off, file-processing with workbench on and sandboxed)
2. KAIROS reads the local file path from the user's intent ("the PDF on my desktop")
3. Uploads file content to the workbench via API
4. LLM executes Python to extract text and summarize
5. KAIROS speaks the summary

**Risk:** Enabling the workbench also enables `COMPOSIO_REMOTE_BASH_TOOL`, which lets the LLM run arbitrary bash in Composio's cloud sandbox. This is a security consideration. The mitigation is prompt-level restriction: "Only use COMPOSIO_REMOTE_WORKBENCH for processing files provided by the user. Do not use COMPOSIO_REMOTE_BASH_TOOL."

**Effort:** M — file upload to workbench requires understanding Composio's workbench file upload API (not fully documented in prior research). Needs a spike to verify.
**Viral potential:** 8/10 — "I just said 'summarize the PDF on my desktop' and it worked" is very shareable
**Phase:** C.2.8. Add a research spike first to verify workbench file upload API. Not C.2.7 because it reverses the workbench decision and needs its own safety review.

---

### Hook 9 — "It speaks the language of YOUR tools"

**Description:** User has a custom internal app (e.g., a restaurant's POS, a legal firm's matter management system). KAIROS integrates it via Custom Toolkits.

**Composio features enabling this:**
- `experimental_createToolkit()` — define new integrations

**Constraint:** Same MCP limitation as Custom Tools (Section A3). Custom toolkits only work in native mode.

**Effort:** XL + blocked on Composio MCP support for custom toolkits
**Viral potential:** 9/10 for the right user (enterprise/SMB with custom tools), 3/10 for consumer
**Phase:** Skip for now. Revisit when Composio ships custom toolkits via MCP.

---

## Section C: Feature Chaining for Compound Value

### Chain 1: `COMPOSIO_SEARCH_TOOLS` + `COMPOSIO_MULTI_EXECUTE_TOOL` = Autonomous Workflow Discovery + Execution

**What chains:** Agent discovers the right tools for an unknown task AND immediately chains them in one request.

**User-visible capability:** "Post a summary of my week to LinkedIn and email it to my newsletter list." KAIROS has never been explicitly told how to do this. Agent calls `COMPOSIO_SEARCH_TOOLS('linkedin post')` + `COMPOSIO_SEARCH_TOOLS('email newsletter')`, finds the right tools, then calls `COMPOSIO_MULTI_EXECUTE_TOOL([linkedin_create_post, gmail_send])` — all in one conversation turn.

**Composio features:** `COMPOSIO_SEARCH_TOOLS` (discovery) + `COMPOSIO_MULTI_EXECUTE_TOOL` (execution chain) + session with all connected toolkits loaded

**Effort:** S (system prompt additions only — both tools already exist in every session)
**Viral score:** 10/10 — this is the "AI that figures out how to do things you've never shown it" demo

**Plan amendment:** Add to KAIROS's LLM system prompt: "When the user's request spans multiple services or when you're unsure which tool to use, (1) call COMPOSIO_SEARCH_TOOLS to discover relevant tools, then (2) call COMPOSIO_MULTI_EXECUTE_TOOL to chain the actions. Do not execute tools sequentially when COMPOSIO_MULTI_EXECUTE_TOOL is available."

---

### Chain 2: `COMPOSIO_MANAGE_CONNECTIONS` + Auto-Open Browser = Frictionless Mid-Task Auth

**What chains:** In-chat auth meta-tool (agent-initiated) + KAIROS's voice announcement + programmatic `open()` browser call

**User-visible capability:** User asks "send this to my Notion" when Notion isn't connected. Agent doesn't fail with "I can't do that." Instead, mid-task, it opens Notion's OAuth page, user clicks Allow, agent retries and succeeds — all within the same voice interaction. User never had to go to Settings.

**Composio features:** `COMPOSIO_MANAGE_CONNECTIONS` (auto-included) + Path B in the C.2.7 plan

**Effort:** S (already in C.2.7 Path B plan — just needs the URL-detection-and-delegate logic in Task 8)
**Viral score:** 9/10 — "my AI connected a new app mid-conversation without asking me to go to settings" is a killer moment

---

### Chain 3: `COMPOSIO_SEARCH_TOOLS` + Post-Connection Announcement = "It Introduces Itself to Your App"

**What chains:** After successful connection, KAIROS calls `COMPOSIO_SEARCH_TOOLS(toolkit_slug)` and announces what it can now do.

**User-visible capability:** Connect GitHub → KAIROS immediately says "GitHub connected. I can now create issues, review PRs, trigger workflows, and check repo stats. Want me to show you what PRs are waiting on your review?"

**Composio features:** `COMPOSIO_SEARCH_TOOLS` + `connectionRequest.waitForConnection()` completion hook

**Effort:** S — 20 lines in ConnectionFlow.connect() completion handler
**Viral score:** 8/10 — makes the connection moment feel like meeting a new collaborator, not installing a plugin

---

### Chain 4: STANDING_ORDERS (existing) + `COMPOSIO_MULTI_EXECUTE_TOOL` + Session Persistence = Persistent Cross-Service Automation

**What chains:** KAIROS's existing STANDING_ORDERS (periodic task memory) + Composio multi-execute + stable session resume on restart

**User-visible capability:** "Every day at 9am, check my GitHub notifications, find any PRs assigned to me, and remind me via voice which ones are overdue." User sets this once. It runs every day even after restarts because the session persists and STANDING_ORDERS fire on schedule.

**Composio features:** `COMPOSIO_MULTI_EXECUTE_TOOL` + `composio.use(sessionId)` session resume + `session.update()` to ensure toolkits are loaded

**Effort:** M — requires STANDING_ORDERS → Composio bridge (new intent type that knows to route to Composio rather than local execution)
**Viral score:** 9/10 — "my AI has been doing this every morning for a month" is the pinnacle of productivity virality
**Phase:** C.2.8

---

### Chain 5: Triggers (C.2.8) + `COMPOSIO_MULTI_EXECUTE_TOOL` + Voice Output = Reactive Cross-Service Automation

**What chains:** Composio Triggers (real-time events) + multi-tool execution + KAIROS voice announcement

**User-visible capability:** "When anyone creates a Linear issue assigned to me, check if it has a GitHub PR linked, find the PR author on Slack, and tell me who I should talk to." The trigger fires (Linear issue created) → KAIROS executes a 3-step cross-service lookup → speaks the result.

**Composio features:** `LINEAR_ISSUE_CREATED_TRIGGER` + `COMPOSIO_MULTI_EXECUTE_TOOL([github_get_pr, slack_find_user])` + Pusher subscription (C.2.8)

**Effort:** L — requires full C.2.8 trigger infrastructure + the multi-execute chain
**Viral score:** 10/10 — "it alerted me to something that happened across three apps simultaneously" is the demo that goes viral

---

### Chain 6: Tool Tags (destructiveHint) + Voice Confirmation = "The AI That Asks First"

**What chains:** Composio tool annotations (or KAIROS's own static destructive-tool list) + voice confirmation gate

**User-visible capability:** User says "archive all my old Linear issues." Before executing: KAIROS says "I'm about to archive 47 Linear issues. This can't be undone. Say yes to continue, or no to cancel." User says yes. It executes. User tweets about the AI that checked with them before doing something irreversible.

**Composio features:** `destructiveHint` from MCP tool annotations (if Composio surfaces them), OR KAIROS's own static list of destructive tool name patterns

**Effort:** S — static pattern matching on tool names (`*delete*`, `*remove*`, `*archive*`, `*trash*`) + voice confirmation hook in the tool execution pipeline. No Composio API changes needed.
**Viral score:** 7/10 — builds trust, shareable moment, positions KAIROS as "responsible AI"
**Phase:** C.2.7 — this is a pure KAIROS-side implementation, no Composio feature dependency

---

## Section D: Concrete Recommendations

### FOLD INTO C.2.7 (current plan) — <2h each, high impact

**D.1 — System prompt additions for SEARCH + MULTI_EXECUTE**

What: Add two sentences to KAIROS's LLM system prompt for the Composio agency session:
1. "When unsure which tool to use, call COMPOSIO_SEARCH_TOOLS with a description of what you need."
2. "When a user's request spans multiple apps, use COMPOSIO_MULTI_EXECUTE_TOOL to chain actions in one request rather than executing them one at a time."

Why it's viral: Enables Hook 2 (multi-app workflow) and Hook 3 (tool discovery) with ZERO code changes. Pure prompt.

Effort: S (30 minutes). Test with one multi-step scenario.

Implementation location: `src/daemon/connectors/composioSessionManager.ts` system prompt construction, or the agency layer's base system prompt.

**D.2 — Post-connection tool announcement ("KAIROS introduces itself to the app")**

What: After `connectionRequest.waitForConnection()` resolves in `ConnectionFlow.connect()`, call `COMPOSIO_SEARCH_TOOLS` for the newly connected toolkit (or call `session.toolkits()` to get the tool count), format a brief announcement, and emit it to the voice layer.

Voice output template: "[App] connected. I can now [verb 1], [verb 2], and [verb 3]. [Optional: suggested first action]."

Why it's viral: The connection moment goes from "Gmail connected." (flat) to "Gmail connected. I can now read your inbox, send emails, and search your messages. Want me to check for any unread messages from today?" (alive, curious, useful).

Effort: S (2 hours). Lives in `ConnectionFlow.connect()` completion handler. Uses either `COMPOSIO_SEARCH_TOOLS` via a quick LLM call or a direct `session.toolkits()` query for tool count.

Implementation location: `src/daemon/connectors/connectionFlow.ts` — add `onConnected()` hook after `waitForConnection()` resolves.

**D.3 — "What can you do with [app]?" voice intent**

What: New `DiscoverToolsIntent` that recognizes patterns like "what can you do with my GitHub?", "what GitHub tools do you have?", "show me what you can do with Slack." Handler calls `COMPOSIO_SEARCH_TOOLS(query='{app_name}')`, formats top 5 results as a voice-friendly list, speaks it.

Why it's viral: Users love exploring their AI's capabilities. This is the interactive "getting to know KAIROS" moment that people demo to friends. "Ask it what it can do with your Gmail" is an invitation to share.

Effort: M (3 hours including intent pattern matching + response formatting). Reuses COMPOSIO_SEARCH_TOOLS which already exists.

Implementation location: `src/daemon/intents/discoverToolsIntent.ts` — new file.

**D.4 — Destructive tool confirmation gate**

What: In the tool execution pipeline (wherever `McpHost` dispatches tool calls from the LLM), intercept calls where the tool name matches a destructive pattern (`/delete|remove|archive|trash|purge|revoke/i`). Before executing, KAIROS speaks: "I'm about to [action]. [Estimated scope if available]. Say yes to confirm or no to cancel." Wait for voice response.

Why it's viral: The "it asked before deleting" moment. Builds user trust and is highly shareable. Positions KAIROS as a responsible agent, not an uncontrolled automation.

Effort: S (2 hours). Pattern matching + voice confirmation in tool dispatch pipeline.

Implementation location: `src/daemon/mcp/mcpHost.ts` — add a `DestructiveToolGuard` interceptor before tool execution.

---

### ADD TO C.2.8 — Higher-effort, high viral potential

**D.5 — "Notify me when [GitHub/Slack/Linear event]" — C.2.8 core**

Full trigger architecture from `2026-05-27-composio-triggers-proactivity.md`. The killer demo: "Notify me when anyone opens a PR on my repo" → GitHub webhook trigger → real-time Pusher delivery → KAIROS voice interrupt.

Why top viral: The first time KAIROS interrupts you to say "A new PR just opened on your repo — want me to review it?" without you asking, users will post this to Twitter immediately.

Effort: L. Full TriggerListener + MonitoringIntentHandler + TriggerRouter architecture.

**D.6 — STANDING_ORDERS × Composio bridge**

"Every Monday, summarize my week's GitHub activity and post it to my Notion daily journal." STANDING_ORDERS (already built) as the scheduler, `COMPOSIO_MULTI_EXECUTE_TOOL` as the execution chain, session.update() to ensure the right toolkits are loaded.

Why top viral: Recurring automations are the "I set it and forgot it" moment that turns KAIROS users into evangelists. "My AI has been doing this every week for 3 months" is unbeatable social proof.

Effort: M. Requires STANDING_ORDERS → Composio bridge (new intent category + execution path).

**D.7 — Workbench file processing ("Summarize the PDF on my desktop")**

Enable workbench for file-processing sessions only (separate session type with `workbench: { enable: true, sandboxSize: 'medium' }`). KAIROS reads local file, uploads to workbench, LLM processes with Python, speaks summary.

Why top viral: "I just said 'summarize that PDF' out loud and it did it" is one of the most compelling AI demos.

Effort: M. Requires workbench file upload API research spike + separate session type + prompt safety restrictions.

---

### SKIP ENTIRELY — Looks viral but isn't worth the effort

**Custom Toolkits / Custom Tools API for KAIROS-native tools**

Why it looks viral: "Build your own integrations" sounds powerful. "KAIROS integrates with your internal tools" sounds amazing.

Why it's a trap:
1. Custom tools/toolkits are blocked from MCP in Composio's current implementation ("coming soon"). Using them requires switching from the MCP architecture (session.mcp.url) to native tools mode (session.tools()), which is a significant architectural change.
2. The use case ("integrate your internal CRM") requires significant user configuration — the opposite of "works in 5 seconds."
3. The target user for custom toolkits is an enterprise with dev resources who would build their own integrations anyway. KAIROS's viral target is individual power users.
4. The same viral moment ("KAIROS works with tools it's never seen") is better served by `COMPOSIO_SEARCH_TOOLS` discovering tools within the existing catalog.

**Skip until:** Composio ships custom toolkit support for MCP AND KAIROS has a Phase F Cloud with a configuration UI.

---

## Section D — Plan Amendments

### Amendment C.2.7-V1: Add system prompt directives for SEARCH + MULTI_EXECUTE

**Where:** `ComposioSessionManager.init()` or the agency layer's system prompt construction

**What to add:**
```
When you are unsure which tool to use for a task, call COMPOSIO_SEARCH_TOOLS
with a brief description of what you need before concluding you cannot help.

When a user's request touches multiple apps or services, use
COMPOSIO_MULTI_EXECUTE_TOOL to chain the required actions into a single
efficient request rather than executing them sequentially.
```

**Why:** Enables Hook 2 (multi-app workflow) and Hook 3 (tool discovery) with zero code changes. The most high-leverage change in this entire brainstorm document.

**Effort:** 30 minutes.

---

### Amendment C.2.7-V2: Add post-connection tool announcement to ConnectionFlow

**Where:** `src/daemon/connectors/connectionFlow.ts`, after `waitForConnection()` resolves

**What to add:** A `postConnectionAnnouncement()` private method that calls `COMPOSIO_SEARCH_TOOLS(query=toolkit_slug)` via a brief LLM call (or directly via the Composio SDK's `composio.toolkits.get(slug)` for tool count) and emits a formatted voice announcement: "[App] connected. I can now [capabilities]. [Suggested first action]."

**Why:** The connection moment is the highest-value emotional beat in the entire onboarding flow. Currently planned as a flat "Gmail connected." Making it rich ("Gmail connected — I can now read 47 unread messages, send on your behalf, and search your entire history") is a 2-hour change that dramatically improves first impressions and shareability.

**Effort:** 2 hours.

---

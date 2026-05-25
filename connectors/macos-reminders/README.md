# macos-reminders connector

Bespoke MCP server exposing macOS Reminders.app to KAIROS via AppleScript.

## Tools

- `list_reminders` — list incomplete reminders from the default list
- `add_reminder` — add a new reminder, optionally with ISO 8601 due date (`due_iso`)
- `complete_reminder` — mark a reminder by title as completed (first match)

## Standalone

```bash
bun run server/index.ts
```

## Wire into KAIROS

Edit `~/.kairos/mcp-servers.json` and set `enabled: true` for the macos-reminders entry. Restart the daemon.

On first AppleScript call, macOS will prompt for Reminders access — approve once.

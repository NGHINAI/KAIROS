// Writes the example STANDING_ORDERS.md on first run if absent.

import { existsSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'

const SEED_CONTENT = `# KAIROS Standing Orders
# Edit this file in any text editor. KAIROS reloads automatically on save.
# Write rules in plain English — KAIROS compiles them into triggers.

# Example rules (delete or modify):
- If I have a calendar event starting in 10 minutes and I'm not in a video call, remind me.
- If I copy a URL to the clipboard, fetch its title and add to recent reading.
- If I open the same file three times in 10 minutes, suggest opening the related PR.
- Never proactively interrupt me on Sunday before 11am or after 10pm any day.
- If a Slack DM contains the word "urgent", interrupt me regardless of context.
`

export function ensureSeedFile(path: string): void {
  if (existsSync(path)) return
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, SEED_CONTENT, 'utf8')
}

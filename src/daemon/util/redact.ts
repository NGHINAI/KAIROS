// src/daemon/util/redact.ts
// Shared secret scrubber. Mirrors the SECRET_PATTERNS in persona/trajWriter.ts (and
// C.1.5 UrgencyFloor) — keep in sync. Used anywhere user/tool text is persisted to a
// durable, later-readable store (e.g. the activity log) so a key can never leak into it.

const SECRET_PATTERNS: RegExp[] = [
  /sk-[a-zA-Z0-9_-]{20,}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /xox[bpoa]-[a-zA-Z0-9-]+/g,
  /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /AKIA[A-Z0-9]{16}/g,
  /ak_[a-zA-Z0-9_-]{20,}/g, // Composio API key pattern
  /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
]

export function redactSecrets(text: string): string {
  let out = String(text ?? "")
  for (const re of SECRET_PATTERNS) out = out.replace(re, "<REDACTED>")
  return out
}

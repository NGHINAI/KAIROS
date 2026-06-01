// scripts/voice-live.ts
// Thin entry point — sets KAIROS_WITH_VOICE=true and invokes the main daemon.
// All voice + agent logic lives in src/daemon/index.ts now.

process.env.KAIROS_WITH_VOICE = "true"
process.env.KAIROS_DAEMON_PORT = process.env.KAIROS_DAEMON_PORT ?? "9876"

await import("../src/daemon/index")

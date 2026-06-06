// scripts/setup-soul.ts
// First-run wizard for ~/.kairos/soul.md. Voice-driven version ships in Phase E.

import { Database } from 'bun:sqlite'
import { SoulWizard } from '../src/daemon/persona/soulWizard'
import { buildRouter } from '../src/daemon/llm'
import { loadConfig } from '../src/daemon/config'
import { homedir } from 'os'
import { join } from 'path'

const config = loadConfig()
const db = new Database(':memory:')
const router = buildRouter(db, config.proactive.providerConfigPath, config.mode ?? 'byo')
const wizard = new SoulWizard({
  path: join(homedir(), '.kairos', 'soul.md'),
  router,
})

function askLine(prompt: string): Promise<string> {
  process.stdout.write(prompt + '\n> ')
  return new Promise(resolve => {
    process.stdin.once('data', d => resolve(d.toString().trim()))
  })
}

console.log("Welcome to KAIROS. Five quick questions to set up how we'll work together.")
console.log("(You can edit ~/.kairos/soul.md anytime to change my answers.)\n")

const answers = {
  ideal_coworker: await askLine('1) How would you describe your ideal AI coworker?'),
  communication_priorities: await askLine('\n2) What matters most in how I communicate with you?'),
  never_do: await askLine('\n3) Are there things I should NEVER do?'),
  focus_behavior: await askLine('\n4) When you are focused on something, how should I behave?'),
  other_guidance: await askLine('\n5) Anything else I should know about you?'),
}

console.log('\nComposing your soul.md...\n')
const soul = await wizard.compose(answers)
console.log(`✓ soul.md written. Vibe: ${soul.vibe}`)
console.log(`  ${soul.core_truths.length} core truths, ${soul.boundaries.length} user-added boundaries.`)
console.log(`  4 baseline safety boundaries always enforced (see SoulLoader.BASELINE_BOUNDARIES).`)
process.exit(0)

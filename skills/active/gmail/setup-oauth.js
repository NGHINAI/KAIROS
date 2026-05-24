#!/usr/bin/env node
// OAuth setup wizard for the Gmail skill.
// Run: node setup-oauth.js
// Prompts user to visit auth URL, paste the code, and saves the token.

import { createInterface } from 'readline'
import { getAuthClient, getAuthUrl, saveToken, loadCredentials } from './auth.js'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const question = (q) => new Promise((resolve) => rl.question(q, resolve))

async function main() {
  console.log('\n🔐 Gmail OAuth Setup for KAIROS\n')

  // Verify credentials exist first
  try {
    loadCredentials()
  } catch (err) {
    console.error('❌ ' + err.message)
    console.error('\nFull setup guide: skills/active/gmail/SETUP.md\n')
    console.error('Quick steps:')
    console.error('  1. Go to https://console.cloud.google.com/')
    console.error('  2. Create/select a project → APIs & Services → Library → Gmail API → Enable')
    console.error('  3. APIs & Services → OAuth consent screen → External → configure + add yourself as test user')
    console.error('  4. APIs & Services → Credentials → Create Credentials → OAuth client ID → Desktop app')
    console.error('  5. Copy Client ID + Secret into state/secrets.json under google_oauth\n')
    process.exit(1)
  }

  const url = getAuthUrl()
  console.log('Visit this URL to authorize KAIROS:\n')
  console.log('  ' + url)
  console.log('\nAfter authorizing, Google will show you a code.\n')

  const code = await question('Paste the authorization code here: ')
  rl.close()

  if (!code.trim()) {
    console.error('No code entered — aborting.')
    process.exit(1)
  }

  const client = getAuthClient()
  const { tokens } = await client.getToken(code.trim())
  saveToken(tokens)

  console.log('\n✓ Token saved to state/gmail_token.json')
  console.log('✓ Gmail skill is now authorized')
  if (tokens.refresh_token) {
    console.log('✓ Refresh token stored — won\'t need to re-authorize')
  } else {
    console.log('⚠️  No refresh token received — you may need to re-authorize when token expires')
  }
}

main().catch((err) => {
  console.error('Auth failed:', err.message)
  process.exit(1)
})

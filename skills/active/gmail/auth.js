#!/usr/bin/env node
// Gmail OAuth token management.
// Reads credentials from state/secrets.json (google_oauth key).
// Stores access+refresh tokens in state/gmail_token.json.
// Re-exports: getAuthClient(), getOrRefreshToken()

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { google } from 'googleapis'

const SKILL_DIR = dirname(fileURLToPath(import.meta.url))
// Walk up to sandbox root (skills/active/gmail -> skills/active -> skills -> root)
const SANDBOX_ROOT = join(SKILL_DIR, '..', '..', '..')
const SECRETS_PATH = join(SANDBOX_ROOT, 'state', 'secrets.json')
const TOKEN_PATH = join(SANDBOX_ROOT, 'state', 'gmail_token.json')

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.labels',
  'https://www.googleapis.com/auth/gmail.modify',
]

export function loadCredentials() {
  if (!existsSync(SECRETS_PATH)) {
    throw new Error(`secrets.json not found at ${SECRETS_PATH}`)
  }
  const secrets = JSON.parse(readFileSync(SECRETS_PATH, 'utf8'))
  if (!secrets.google_oauth) {
    throw new Error(
      'No google_oauth key in secrets.json. ' +
      'Add: {"google_oauth": {"client_id": "...", "client_secret": "...", "redirect_uri": "urn:ietf:wg:oauth:2.0:oob"}}'
    )
  }
  const { client_id, client_secret } = secrets.google_oauth
  if (!client_id || client_id.startsWith('YOUR_') || client_id === '') {
    throw new Error(
      'Gmail credentials are still placeholder values. ' +
      'See skills/active/gmail/SETUP.md for instructions to get real OAuth credentials.'
    )
  }
  if (!client_secret || client_secret.startsWith('YOUR_') || client_secret === '') {
    throw new Error(
      'Gmail client_secret is still a placeholder. ' +
      'See skills/active/gmail/SETUP.md for instructions.'
    )
  }
  return secrets.google_oauth
}

export function getAuthClient() {
  const creds = loadCredentials()
  const { client_id, client_secret, redirect_uri } = creds
  return new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uri || 'urn:ietf:wg:oauth:2.0:oob'
  )
}

export function getAuthUrl() {
  const client = getAuthClient()
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  })
}

export function loadToken() {
  if (!existsSync(TOKEN_PATH)) return null
  try {
    return JSON.parse(readFileSync(TOKEN_PATH, 'utf8'))
  } catch {
    return null
  }
}

export function saveToken(token) {
  writeFileSync(TOKEN_PATH, JSON.stringify(token, null, 2))
}

export async function getAuthenticatedClient() {
  const client = getAuthClient()
  const token = loadToken()
  if (!token) {
    throw new Error('NO_TOKEN: Run setup-oauth.js to authorize KAIROS')
  }
  client.setCredentials(token)

  // Auto-refresh if expiry within 5 minutes
  if (token.expiry_date && token.expiry_date < Date.now() + 300_000) {
    const { credentials } = await client.refreshAccessToken()
    saveToken(credentials)
    client.setCredentials(credentials)
  }

  return client
}
